import { createHash, randomBytes } from "node:crypto";
import { createMockRail, type MockRail } from "@onestepchess/rail-mock";
import algosdk from "algosdk";
import * as ed from "@noble/ed25519";
import { afterEach, describe, expect, it } from "vitest";
import { serverConfigSchema } from "../config.js";
import { openDatabase, type OpenedDatabase } from "../db/open.js";
import {
  type AuthDeps,
  consumeChallenge,
  createChallenge,
  verifyChallengeProof,
} from "./challenge.js";

const PUBLIC_BASE_URL = "https://osc.example";
const opened: OpenedDatabase[] = [];

type Stack = {
  database: OpenedDatabase;
  rail: MockRail;
  deps: AuthDeps;
  setNow: (now: number) => void;
};

function setup(): Stack {
  const database = openDatabase({ path: ":memory:" });
  opened.push(database);
  const rail = createMockRail();
  let now = 1_000_000;
  const deps: AuthDeps = {
    db: database.db,
    rail,
    config: () => serverConfigSchema.parse({}),
    publicBaseUrl: PUBLIC_BASE_URL,
    now: () => now,
  };
  return {
    database,
    rail,
    deps,
    setNow: (value) => {
      now = value;
    },
  };
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    database.sqlite.close();
  }
});

function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** An ed25519 identity whose Algorand address encodes the public key. */
function nobleIdentity() {
  const seed = new Uint8Array(randomBytes(32));
  const publicKey = ed.getPublicKey(seed);
  return { seed, address: algosdk.encodeAddress(publicKey) };
}

function arc60AuthData(domain: string): Uint8Array {
  const flags = new Uint8Array([0x05, 0, 0, 0, 0]);
  return new Uint8Array([...sha256(domain), ...flags]);
}

function signArc60(
  seed: Uint8Array,
  siwaDataB64: string,
  authData: Uint8Array,
): Uint8Array {
  const message = new Uint8Array([
    ...sha256(fromB64(siwaDataB64)),
    ...sha256(authData),
  ]);
  return ed.sign(message, seed);
}

describe("auth challenge contract (§6.3)", () => {
  it("returns the exact pinned field set", () => {
    const stack = setup();
    const { address } = nobleIdentity();
    const challenge = createChallenge(stack.deps, address);

    expect(Object.keys(challenge).sort()).toEqual([
      "arc60Payload",
      "expiresAt",
      "fallbackTxnB64",
      "nonce",
    ]);
    expect(challenge.arc60Payload.metadata).toEqual({
      scope: 1,
      encoding: "base64",
    });
    expect(challenge.expiresAt).toBe(new Date(1_000_000 + 300_000).toISOString());

    const siwa = JSON.parse(
      Buffer.from(challenge.arc60Payload.data, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(siwa.domain).toBe("osc.example");
    expect(siwa.uri).toBe("https://osc.example");
    expect(siwa.account_address).toBe(address);
    expect(siwa.nonce).toBe(challenge.nonce);
    expect(siwa.chain_id).toBe("283");
    expect(siwa.version).toBe("1");
    expect(siwa.type).toBe("ed25519");
  });

  it("rejects a malformed address", () => {
    const stack = setup();
    expect(() => createChallenge(stack.deps, "not-an-address")).toThrowError(
      /INVALID_ADDRESS/,
    );
  });

  it("a new challenge replaces the prior one for the address", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const first = createChallenge(stack.deps, identity.address);
    const second = createChallenge(stack.deps, identity.address);
    expect(second.nonce).not.toBe(first.nonce);
    expect(
      stack.database.sqlite
        .prepare("SELECT count(*) AS n FROM auth_nonces")
        .get(),
    ).toEqual({ n: 1 });

    // A proof over the replaced challenge no longer verifies.
    const domainData = arc60AuthData("osc.example");
    const staleSig = signArc60(identity.seed, first.arc60Payload.data, domainData);
    const stale = await verifyChallengeProof(stack.deps, identity.address, {
      method: "arc60",
      signatureB64: Buffer.from(staleSig).toString("base64"),
      authenticatorDataB64: Buffer.from(domainData).toString("base64"),
    });
    expect(stale).toEqual({ ok: false, code: "INVALID_SIGNATURE" });

    const freshSig = signArc60(identity.seed, second.arc60Payload.data, domainData);
    const fresh = await verifyChallengeProof(stack.deps, identity.address, {
      method: "arc60",
      signatureB64: Buffer.from(freshSig).toString("base64"),
      authenticatorDataB64: Buffer.from(domainData).toString("base64"),
    });
    expect(fresh).toEqual({ ok: true });
  });

  it("an expired nonce fails with NONCE_EXPIRED", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const challenge = createChallenge(stack.deps, identity.address);
    stack.setNow(1_000_000 + 300_001);
    const domainData = arc60AuthData("osc.example");
    const sig = signArc60(identity.seed, challenge.arc60Payload.data, domainData);
    const outcome = await verifyChallengeProof(stack.deps, identity.address, {
      method: "arc60",
      signatureB64: Buffer.from(sig).toString("base64"),
      authenticatorDataB64: Buffer.from(domainData).toString("base64"),
    });
    expect(outcome).toEqual({ ok: false, code: "NONCE_EXPIRED" });
  });
});

describe("ARC-60 verification (F2)", () => {
  async function verifyWith(
    stack: Stack,
    identity: { seed: Uint8Array; address: string },
    options: {
      signSeed?: Uint8Array;
      domain?: string;
      tamper?: boolean;
    } = {},
  ) {
    const challenge = createChallenge(stack.deps, identity.address);
    const authData = arc60AuthData(options.domain ?? "osc.example");
    const signature = signArc60(
      options.signSeed ?? identity.seed,
      challenge.arc60Payload.data,
      authData,
    );
    if (options.tamper) {
      // Flip a byte after signing — sits past the domain hash prefix.
      authData[35] = (authData[35] as number) ^ 0xff;
    }
    return verifyChallengeProof(stack.deps, identity.address, {
      method: "arc60",
      signatureB64: Buffer.from(signature).toString("base64"),
      authenticatorDataB64: Buffer.from(authData).toString("base64"),
    });
  }

  it("verifies a well-formed ARC-60 proof", async () => {
    const stack = setup();
    expect(await verifyWith(stack, nobleIdentity())).toEqual({ ok: true });
  });

  it("fails INVALID_SIGNATURE for a wrong key", async () => {
    const stack = setup();
    const other = nobleIdentity();
    expect(
      await verifyWith(stack, nobleIdentity(), { signSeed: other.seed }),
    ).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("fails INVALID_SIGNATURE for a wrong domain hash", async () => {
    const stack = setup();
    expect(
      await verifyWith(stack, nobleIdentity(), { domain: "evil.example" }),
    ).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("fails INVALID_SIGNATURE for tampered authenticator data", async () => {
    const stack = setup();
    expect(await verifyWith(stack, nobleIdentity(), { tamper: true })).toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
  });
});

describe("fallback transaction verification (F2)", () => {
  function txnProof(signedTxn: Uint8Array) {
    return {
      method: "txn" as const,
      signedTxnB64: Buffer.from(signedTxn).toString("base64"),
    };
  }

  it("verifies the exact challenge transaction signed with algosdk", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const address = account.addr.toString();
    const challenge = createChallenge(stack.deps, address);
    const txn = algosdk.decodeUnsignedTransaction(
      fromB64(challenge.fallbackTxnB64),
    );
    const outcome = await verifyChallengeProof(
      stack.deps,
      address,
      txnProof(txn.signTxn(account.sk)),
    );
    expect(outcome).toEqual({ ok: true });
  });

  it("the challenge txn is invalid by construction (unsubmittable)", () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const challenge = createChallenge(stack.deps, account.addr.toString());
    const txn = algosdk.decodeUnsignedTransaction(
      fromB64(challenge.fallbackTxnB64),
    );
    // Expired validity window plus zero standalone fee: no node accepts it.
    expect(txn.firstValid).toBe(1n);
    expect(txn.lastValid).toBe(1n);
    expect(txn.fee).toBe(0n);
    expect(txn.payment?.amount).toBe(0n);
    expect(txn.sender.toString()).toBe(account.addr.toString());
    expect(txn.payment?.receiver.toString()).toBe(account.addr.toString());
    expect(Buffer.from(txn.note ?? new Uint8Array()).toString("utf8")).toBe(
      `osc-auth:${challenge.nonce}`,
    );
    expect(txn.group).toBeUndefined();
    expect(txn.rekeyTo).toBeUndefined();
  });

  it.each([
    ["mutated note", (p: MutationParams) => ({ ...p, note: "osc-auth:other" })],
    [
      "mutated validity window",
      (p: MutationParams) => ({ ...p, lastValid: 1_000 }),
    ],
    [
      "mutated genesis",
      (p: MutationParams) => ({
        ...p,
        genesisHashB64: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
        genesisID: "testnet-v1.0",
      }),
    ],
    ["added rekey field", (p: MutationParams) => ({ ...p, rekey: true })],
    ["added group field", (p: MutationParams) => ({ ...p, group: true })],
  ])("rejects a %s", async (_label, mutate) => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const address = account.addr.toString();
    const challenge = createChallenge(stack.deps, address);
    const params = mutate({
      address,
      note: `osc-auth:${challenge.nonce}`,
      lastValid: 1,
      genesisHashB64: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
      genesisID: "mainnet-v1.0",
    });
    const mutated = buildTxn(params);
    const outcome = await verifyChallengeProof(
      stack.deps,
      address,
      txnProof(mutated.signTxn(account.sk)),
    );
    expect(outcome).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("rejects a different sender signing its own copy", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const other = algosdk.generateAccount();
    const address = account.addr.toString();
    const challenge = createChallenge(stack.deps, address);
    const foreign = buildTxn({
      address: other.addr.toString(),
      note: `osc-auth:${challenge.nonce}`,
      lastValid: 1,
      genesisHashB64: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
      genesisID: "mainnet-v1.0",
    });
    const outcome = await verifyChallengeProof(
      stack.deps,
      address,
      txnProof(foreign.signTxn(other.sk)),
    );
    expect(outcome).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });
});

type MutationParams = {
  address: string;
  note: string;
  lastValid: number;
  genesisHashB64: string;
  genesisID: string;
  rekey?: boolean;
  group?: boolean;
};

function buildTxn(params: MutationParams): algosdk.Transaction {
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: params.address,
    receiver: params.address,
    amount: 0,
    note: new TextEncoder().encode(params.note),
    ...(params.rekey ? { rekeyTo: algosdk.generateAccount().addr } : {}),
    suggestedParams: {
      fee: 0,
      flatFee: true,
      minFee: 1_000,
      firstValid: 1,
      lastValid: params.lastValid,
      genesisHash: new Uint8Array(Buffer.from(params.genesisHashB64, "base64")),
      genesisID: params.genesisID,
    },
  });
  if (params.group) {
    algosdk.assignGroupID([txn]);
  }
  return txn;
}

describe("nonce lifecycle and rail preconditions (F2)", () => {
  it("a consumed nonce cannot be replayed; an unconsumed proof stays reusable", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const challenge = createChallenge(stack.deps, identity.address);
    const authData = arc60AuthData("osc.example");
    const proof = {
      method: "arc60" as const,
      signatureB64: Buffer.from(
        signArc60(identity.seed, challenge.arc60Payload.data, authData),
      ).toString("base64"),
      authenticatorDataB64: Buffer.from(authData).toString("base64"),
    };

    // Recoverable registration errors re-verify without a new challenge.
    expect(await verifyChallengeProof(stack.deps, identity.address, proof)).toEqual(
      { ok: true },
    );
    expect(await verifyChallengeProof(stack.deps, identity.address, proof)).toEqual(
      { ok: true },
    );

    // Success consumes the nonce; a replay then fails.
    consumeChallenge(stack.deps.db, identity.address);
    expect(await verifyChallengeProof(stack.deps, identity.address, proof)).toEqual(
      { ok: false, code: "NONCE_EXPIRED" },
    );
  });

  it("a rekeyed account fails REKEYED_UNSUPPORTED before key verification", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const challenge = createChallenge(stack.deps, identity.address);
    stack.rail.control.setAccountInfo(identity.address, { rekeyed: true });
    const authData = arc60AuthData("osc.example");
    const outcome = await verifyChallengeProof(stack.deps, identity.address, {
      method: "arc60",
      signatureB64: Buffer.from(
        signArc60(identity.seed, challenge.arc60Payload.data, authData),
      ).toString("base64"),
      authenticatorDataB64: Buffer.from(authData).toString("base64"),
    });
    expect(outcome).toEqual({ ok: false, code: "REKEYED_UNSUPPORTED" });
  });

  it("a rail outage is DEPENDENCY_UNAVAILABLE and leaves the nonce live", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const challenge = createChallenge(stack.deps, identity.address);
    const authData = arc60AuthData("osc.example");
    const proof = {
      method: "arc60" as const,
      signatureB64: Buffer.from(
        signArc60(identity.seed, challenge.arc60Payload.data, authData),
      ).toString("base64"),
      authenticatorDataB64: Buffer.from(authData).toString("base64"),
    };

    stack.rail.control.failQueries(["account"]);
    expect(await verifyChallengeProof(stack.deps, identity.address, proof)).toEqual(
      { ok: false, code: "DEPENDENCY_UNAVAILABLE" },
    );

    stack.rail.control.restoreQueries();
    expect(await verifyChallengeProof(stack.deps, identity.address, proof)).toEqual(
      { ok: true },
    );
  });
});
