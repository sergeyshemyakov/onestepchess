import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostMoveResult } from "../api/client.js";
import type { Meta, MoveReceipt } from "../api/schemas.js";
import {
  cachedHeaderFor,
  payMove,
  resetHeaderCacheForTests,
  synthesizeMockHeader,
  validateChallenge,
} from "./x402.js";

afterEach(resetHeaderCacheForTests);

const meta = {
  network: {
    caip2: "mock:local",
    usdcAssetId: "31566704",
    treasuryAddress: "TREASURY",
    facilitatorUrl: "http://localhost:4402",
    explorerBaseUrl: "https://explorer",
    algodUrl: "http://localhost:4001",
  },
} as Meta;

const MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

const requirement = {
  scheme: "mock",
  network: "mock:local",
  asset: "31566704",
  amount: "1000",
  payTo: "TREASURY",
  maxTimeoutSeconds: 120,
  extra: {},
};

function challengeB64(
  overrides: Record<string, unknown> = {},
  req: Record<string, unknown> = {},
) {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "http://localhost:3000/api/v1/claims/clm_1/move" },
      accepts: [{ ...requirement, ...req }],
      ...overrides,
    }),
  );
}

const validArgs = { claimId: "clm_1", stakeMicroUsdc: 1000, meta };

describe("challenge validation matrix (#32)", () => {
  it("accepts the pinned mock challenge", () => {
    expect(validateChallenge(challengeB64(), validArgs).ok).toBe(true);
  });

  it("rejects a wrong amount before any signer or retry", () => {
    const result = validateChallenge(
      challengeB64({}, { amount: "2000" }),
      validArgs,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("amount"),
    });
  });

  it("rejects a wrong payTo", () => {
    const result = validateChallenge(
      challengeB64({}, { payTo: "ATTACKER" }),
      validArgs,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("treasury"),
    });
  });

  it("rejects a wrong asset", () => {
    const result = validateChallenge(
      challengeB64({}, { asset: "1" }),
      validArgs,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("asset"),
    });
  });

  it("rejects a non-canonical resource URL", () => {
    const bad = btoa(
      JSON.stringify({
        x402Version: 2,
        resource: { url: "http://localhost:3000/api/v1/claims/other/move" },
        accepts: [requirement],
      }),
    );
    expect(validateChallenge(bad, validArgs)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("resource"),
    });
  });

  it("rejects multiple accepts entries", () => {
    const bad = btoa(
      JSON.stringify({
        x402Version: 2,
        resource: { url: "http://localhost:3000/api/v1/claims/clm_1/move" },
        accepts: [requirement, requirement],
      }),
    );
    expect(validateChallenge(bad, validArgs)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("exactly one"),
    });
  });

  it("rejects a wrong x402 version", () => {
    expect(
      validateChallenge(challengeB64({ x402Version: 1 }), validArgs),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("V2"),
    });
  });
});

it("t1_fixtures_are_consumed_by_web_payment_guards", () => {
  const address = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
  const exactMeta = {
    network: {
      ...meta.network,
      caip2: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
      usdcAssetId: "10458941",
      treasuryAddress: address,
    },
  } as Meta;
  const fixtureRequirement = {
    scheme: "exact",
    network: exactMeta.network.caip2,
    asset: "10458941",
    amount: "1000",
    payTo: address,
    maxTimeoutSeconds: 120,
    extra: { feePayer: address, decimals: 6 },
  };
  const fixture = btoa(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://osc.example/api/v1/claims/clm_1/move" },
      accepts: [fixtureRequirement],
    }),
  );
  const args = { ...validArgs, meta: exactMeta };

  expect(validateChallenge(fixture, args)).toMatchObject({ ok: true });
  for (const mutation of [
    { network: MAINNET_CAIP2 },
    { extra: { feePayer: "unsafe", decimals: 6 } },
    { extra: { feePayer: address, decimals: 5 } },
  ]) {
    const mutated = btoa(
      JSON.stringify({
        x402Version: 2,
        resource: { url: "https://osc.example/api/v1/claims/clm_1/move" },
        accepts: [{ ...fixtureRequirement, ...mutation }],
      }),
    );
    expect(validateChallenge(mutated, args).ok).toBe(false);
  }
});

const receipt: MoveReceipt = {
  status: "moved",
  move: { uci: "e2e4", san: "e4" },
  debitMicroUsdc: 1000,
  txid: "mocktx_7",
  explorerUrl: "https://explorer/tx/mocktx_7",
  fenAfterYourMove: "after",
};

function scriptedClient(script: readonly PostMoveResult[]) {
  const calls: { move: string; header: string | undefined }[] = [];
  let index = 0;
  return {
    calls,
    postMove: vi.fn(async (_claimId: string, move: string, header?: string) => {
      calls.push({ move, header });
      const result = script[Math.min(index, script.length - 1)];
      index += 1;
      if (result === undefined) throw new Error("script exhausted");
      return result;
    }),
  };
}

const challenge402: PostMoveResult = {
  kind: "payment_required",
  challengeHeader: challengeB64(),
  envelope: { error: "PAYMENT_REQUIRED", hint: "", docs: "" },
};

describe("mock branch (#32)", () => {
  it("synthesizes the rail §5.4 payload and never touches the wallet", async () => {
    const getSigner = vi.fn();
    const client = scriptedClient([challenge402, { kind: "receipt", receipt }]);
    const outcome = await payMove({
      claimId: "clm_1",
      moveUci: "e2e4",
      address: "PLAYER",
      stakeMicroUsdc: 1000,
      meta,
      client,
      getSigner,
    });
    expect(outcome).toEqual({ kind: "receipt", receipt });
    expect(getSigner).not.toHaveBeenCalled();
    const header = client.calls[1]?.header;
    if (header === undefined) throw new Error("no header sent");
    const payload = JSON.parse(atob(header));
    expect(payload).toMatchObject({
      x402Version: 2,
      accepted: requirement,
      payload: {
        from: "PLAYER",
        amountMicroUsdc: 1000,
        asset: "31566704",
        payTo: "TREASURY",
      },
    });
    expect(typeof payload.payload.nonce).toBe("string");
    expect(payload.payload.nonce.length).toBeGreaterThan(0);
  });

  it("the §5.4 synthesizer produces unique nonces per header", () => {
    const args = {
      required: {
        x402Version: 2 as const,
        resource: { url: "http://localhost:3000/api/v1/claims/clm_1/move" },
        accepts: [requirement],
      },
      requirement,
      from: "PLAYER",
    };
    const nonceOf = (header: string) =>
      JSON.parse(atob(header)).payload.nonce as string;
    expect(nonceOf(synthesizeMockHeader(args))).not.toBe(
      nonceOf(synthesizeMockHeader(args)),
    );
  });

  it("exact scheme fails with an explicit unsupported error", async () => {
    const client = scriptedClient([
      {
        kind: "payment_required",
        challengeHeader: challengeB64(
          {},
          {
            scheme: "exact",
            extra: {
              feePayer:
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
              decimals: 6,
            },
          },
        ),
        envelope: { error: "PAYMENT_REQUIRED", hint: "", docs: "" },
      },
    ]);
    const outcome = await payMove({
      claimId: "clm_1",
      moveUci: "e2e4",
      address: "PLAYER",
      stakeMicroUsdc: 1000,
      meta,
      client,
    });
    expect(outcome).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("not supported"),
    });
  });
});

describe("header caching — resend, never re-sign (#32)", () => {
  it("a retry for the same claim resends the byte-identical header", async () => {
    const client = scriptedClient([
      challenge402,
      { kind: "pending", retryAfterSeconds: 5 },
      { kind: "receipt", receipt },
    ]);
    const args = {
      claimId: "clm_1",
      moveUci: "e2e4",
      address: "PLAYER",
      stakeMicroUsdc: 1000,
      meta,
      client,
    };
    const first = await payMove(args);
    expect(first.kind).toBe("pending");
    const sentHeader = client.calls[1]?.header;
    expect(cachedHeaderFor("clm_1")).toBe(sentHeader);

    const second = await payMove(args);
    expect(second).toEqual({ kind: "receipt", receipt });
    // Retry skipped the 402 dance and resent the exact bytes.
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2]?.header).toBe(sentHeader);
    expect(cachedHeaderFor("clm_1")).toBeUndefined();
  });

  it("a definitive 402 failure burns the cached payload", async () => {
    const failure: PostMoveResult = {
      kind: "payment_failed",
      code: "PAYMENT_INVALID",
      envelope: { error: "PAYMENT_INVALID", hint: "verify failed", docs: "" },
      challengeHeader: null,
    };
    const client = scriptedClient([challenge402, failure]);
    const outcome = await payMove({
      claimId: "clm_1",
      moveUci: "e2e4",
      address: "PLAYER",
      stakeMicroUsdc: 1000,
      meta,
      client,
    });
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(cachedHeaderFor("clm_1")).toBeUndefined();
  });
});
