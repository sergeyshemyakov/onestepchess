import algosdk from "algosdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostMoveResult } from "../api/client.js";
import type { Meta, MoveReceipt } from "../api/schemas.js";
import type { ConnectedWallet } from "./provider.js";
import {
  cachedHeaderFor,
  guardExactPaymentGroup,
  payMove,
  resetHeaderCacheForTests,
  synthesizeMockHeader,
  validateChallenge,
} from "./x402.js";

afterEach(() => {
  resetHeaderCacheForTests();
  vi.unstubAllGlobals();
});

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

  it("exact scheme requires a connected wallet", async () => {
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
    expect(outcome).toEqual({ kind: "wallet_disconnected" });
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

const payer = algosdk.generateAccount();
const feePayer = algosdk.generateAccount();
const treasury = algosdk.generateAccount();
const other = algosdk.generateAccount();
const TESTNET_CAIP2 = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const exactMeta = {
  ...meta,
  network: {
    ...meta.network,
    caip2: TESTNET_CAIP2,
    usdcAssetId: "10458941",
    treasuryAddress: treasury.addr.toString(),
    algodUrl: "https://algod.example",
  },
} as Meta;

function exactRequirement(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    scheme: "exact",
    network: TESTNET_CAIP2,
    asset: "10458941",
    amount: "1000",
    payTo: treasury.addr.toString(),
    maxTimeoutSeconds: 120,
    extra: { feePayer: feePayer.addr.toString(), decimals: 6 },
    ...overrides,
  };
}

function exactChallenge(
  requirementOverrides: Record<string, unknown> = {},
  requiredOverrides: Record<string, unknown> = {},
): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://osc.example/api/v1/claims/clm_1/move" },
      accepts: [exactRequirement(requirementOverrides)],
      ...requiredOverrides,
    }),
  );
}

function exactWallet(): ConnectedWallet {
  return {
    address: payer.addr.toString(),
    walletName: "fixture wallet",
    signTransactions: vi.fn(async (transactions) => {
      const transaction = transactions[0];
      if (transaction === undefined) throw new Error("missing transaction");
      return transaction.signTxn(payer.sk);
    }),
  };
}

function suggestedParams() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        fee: 1_000,
        "min-fee": 1_000,
        "last-round": 20_000,
        "genesis-id": "testnet-v1.0",
        "genesis-hash": TESTNET_CAIP2.slice("algorand:".length),
      }),
    ),
  );
}

function paymentRequired(header: string): PostMoveResult {
  return {
    kind: "payment_required",
    challengeHeader: header,
    envelope: { error: "PAYMENT_REQUIRED", hint: "", docs: "" },
  };
}

it("web_exact_payment_rejects_every_wrong_trust_pin_before_loading_or_signing_wallet_code", async () => {
  const mutations = [
    exactChallenge({}, { x402Version: 1 }),
    exactChallenge({}, { accepts: [] }),
    exactChallenge({}, { accepts: [exactRequirement(), exactRequirement()] }),
    exactChallenge(
      {},
      {
        resource: { url: "https://osc.example/api/v1/claims/other/move" },
      },
    ),
    exactChallenge({ network: MAINNET_CAIP2 }),
    exactChallenge({ asset: "1" }),
    exactChallenge({ amount: "999" }),
    exactChallenge({ payTo: other.addr.toString() }),
    exactChallenge({ extra: { feePayer: "unsafe", decimals: 6 } }),
    exactChallenge({ extra: { feePayer: "A".repeat(58), decimals: 6 } }),
  ];
  for (const header of mutations) {
    resetHeaderCacheForTests();
    const getSigner = vi.fn(async () => exactWallet());
    const outcome = await payMove({
      claimId: "clm_1",
      moveUci: "e2e4",
      address: payer.addr.toString(),
      stakeMicroUsdc: 1_000,
      meta: exactMeta,
      client: scriptedClient([paymentRequired(header)]),
      getSigner,
    });
    expect(outcome.kind).toBe("failed");
    expect(getSigner).not.toHaveBeenCalled();
  }
});

function guardedGroup(): algosdk.Transaction[] {
  const genesisHash = new Uint8Array(
    Buffer.from(TESTNET_CAIP2.slice("algorand:".length), "base64"),
  );
  const common = {
    flatFee: true,
    minFee: 1_000,
    firstValid: 20_000,
    lastValid: 21_000,
    genesisID: "testnet-v1.0",
    genesisHash,
  };
  const fee = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: feePayer.addr,
    receiver: feePayer.addr,
    amount: 0,
    note: new TextEncoder().encode("x402-fee-payer-fixture"),
    suggestedParams: { ...common, fee: 2_000 },
  });
  const payment = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: treasury.addr,
    amount: 1_000,
    assetIndex: 10_458_941,
    note: new TextEncoder().encode("x402-payment-v2-fixture"),
    suggestedParams: { ...common, fee: 0 },
  });
  return algosdk.assignGroupID([fee, payment]);
}

function guard(group: algosdk.Transaction[], indexesToSign = [1]) {
  return guardExactPaymentGroup({
    txns: group.map((transaction) =>
      algosdk.encodeUnsignedTransaction(transaction),
    ),
    indexesToSign,
    requirement: exactRequirement() as never,
    signerAddress: payer.addr.toString(),
  });
}

it("web_exact_group_guard_rejects_unsafe_network_fee_validity_and_transaction_fields_before_approval", () => {
  expect(guard(guardedGroup())).toHaveLength(2);
  const signerSpy = vi.fn();
  const submitSpy = vi.fn();
  const guardedApproval = (
    group: algosdk.Transaction[],
    indexesToSign = [1],
  ) => {
    const transactions = guard(group, indexesToSign);
    signerSpy(transactions[1]);
    submitSpy();
  };
  expect(() => guardedApproval(guardedGroup(), [0])).toThrow();
  expect(() =>
    guardedApproval([guardedGroup()[1] as algosdk.Transaction]),
  ).toThrow();

  const mutations: Array<(group: algosdk.Transaction[]) => void> = [
    ([fee]) => {
      if (fee !== undefined) Reflect.set(fee, "sender", other.addr);
    },
    ([fee]) => {
      if (fee?.payment !== undefined)
        Reflect.set(fee.payment, "receiver", other.addr);
    },
    ([fee]) => {
      if (fee?.payment !== undefined) Reflect.set(fee.payment, "amount", 1n);
    },
    ([fee]) => {
      if (fee !== undefined) fee.fee = 1_000n;
    },
    ([fee]) => {
      if (fee !== undefined)
        Reflect.set(fee, "note", new TextEncoder().encode("unsafe"));
    },
    ([fee]) => {
      if (fee !== undefined)
        Reflect.set(fee, "genesisHash", new Uint8Array(32));
    },
    ([fee]) => {
      if (fee !== undefined) Reflect.set(fee, "genesisID", "unsafe-v1");
    },
    ([fee]) => {
      if (fee !== undefined)
        Reflect.set(fee, "group", new Uint8Array(32).fill(1));
    },
    ([, payment]) => {
      if (payment !== undefined) Reflect.set(payment, "sender", other.addr);
    },
    ([, payment]) => {
      if (payment !== undefined) payment.fee = 1_000n;
    },
    ([, payment]) => {
      if (payment !== undefined)
        Reflect.set(payment, "firstValid", payment.lastValid + 1n);
    },
    ([, payment]) => {
      if (payment !== undefined)
        Reflect.set(payment, "lastValid", payment.firstValid + 1_001n);
    },
    ([, payment]) => {
      if (payment !== undefined)
        Reflect.set(payment, "genesisHash", new Uint8Array(32));
    },
    ([, payment]) => {
      if (payment?.assetTransfer !== undefined)
        Reflect.set(payment.assetTransfer, "amount", 999n);
    },
    ([, payment]) => {
      if (payment?.assetTransfer !== undefined)
        Reflect.set(payment.assetTransfer, "receiver", other.addr);
    },
    ([, payment]) => {
      if (payment?.assetTransfer !== undefined)
        Reflect.set(payment.assetTransfer, "assetIndex", 1n);
    },
    ([, payment]) => {
      if (payment !== undefined)
        Reflect.set(payment, "note", new TextEncoder().encode("unsafe"));
    },
    ([, payment]) => {
      if (payment !== undefined)
        Reflect.set(payment, "lease", new Uint8Array(32).fill(1));
    },
    ([, payment]) => {
      if (payment !== undefined) Reflect.set(payment, "rekeyTo", other.addr);
    },
    ([, payment]) => {
      if (payment?.assetTransfer !== undefined)
        Reflect.set(payment.assetTransfer, "closeRemainderTo", other.addr);
    },
    ([, payment]) => {
      if (payment?.assetTransfer !== undefined)
        Reflect.set(payment.assetTransfer, "assetSender", other.addr);
    },
  ];
  for (const mutate of mutations) {
    const group = guardedGroup();
    mutate(group);
    expect(() => guardedApproval(group)).toThrow();
  }
  expect(signerSpy).not.toHaveBeenCalled();
  expect(submitSpy).not.toHaveBeenCalled();
});

it("web_exact_payment_resends_identical_bytes_and_never_resigns_an_inflight_claim", async () => {
  suggestedParams();
  const wallet = exactWallet();
  const getSigner = vi.fn(async () => wallet);
  const client = scriptedClient([
    paymentRequired(exactChallenge()),
    { kind: "pending", retryAfterSeconds: 2 },
    { kind: "in_flight" },
    { kind: "receipt", receipt },
  ]);
  const args = {
    claimId: "clm_1",
    moveUci: "e2e4",
    address: payer.addr.toString(),
    stakeMicroUsdc: 1_000,
    meta: exactMeta,
    client,
    getSigner,
  };
  expect((await payMove(args)).kind).toBe("pending");
  const header = client.calls[1]?.header;
  expect((await payMove(args)).kind).toBe("in_flight");
  expect(client.calls[2]?.header).toBe(header);
  expect(await payMove(args)).toEqual({ kind: "receipt", receipt });
  expect(client.calls[3]?.header).toBe(header);
  expect(getSigner).toHaveBeenCalledTimes(1);
  expect(wallet.signTransactions).toHaveBeenCalledTimes(1);

  resetHeaderCacheForTests();
  const retryWallet = exactWallet();
  const retrySigner = vi.fn(async () => retryWallet);
  const timedOutCalls: Array<string | undefined> = [];
  let request = 0;
  const timedOutClient = {
    postMove: vi.fn(
      async (_claimId: string, _move: string, payment?: string) => {
        timedOutCalls.push(payment);
        request += 1;
        if (request === 1) return paymentRequired(exactChallenge());
        throw new TypeError("response lost after submit");
      },
    ),
  };
  const retryArgs = {
    ...args,
    client: timedOutClient,
    getSigner: retrySigner,
  };
  await expect(payMove(retryArgs)).rejects.toThrow("response lost");
  const timedOutHeader = timedOutCalls[1];
  const switchedClient = scriptedClient([{ kind: "receipt", receipt }]);
  await expect(
    payMove({ ...retryArgs, client: switchedClient }),
  ).resolves.toEqual({ kind: "receipt", receipt });
  expect(switchedClient.calls[0]?.header).toBe(timedOutHeader);
  expect(retryWallet.signTransactions).toHaveBeenCalledTimes(1);

  resetHeaderCacheForTests();
  const reloadClient = scriptedClient([{ kind: "receipt", receipt }]);
  await expect(
    payMove({ ...retryArgs, client: reloadClient }),
  ).resolves.toEqual({ kind: "receipt", receipt });
  expect(retrySigner).toHaveBeenCalledTimes(1);
});

it("web_exact_payment_rebuilds_at_most_once_after_validity_or_fee_payer_expiry", async () => {
  suggestedParams();
  const rotatedFeePayer = algosdk.generateAccount().addr.toString();
  const invalid = (challengeHeader: string): PostMoveResult => ({
    kind: "payment_failed",
    code: "PAYMENT_INVALID",
    envelope: { error: "PAYMENT_INVALID", hint: "stale", docs: "" },
    challengeHeader,
  });
  const getSigner = vi.fn(async () => exactWallet());
  const client = scriptedClient([
    paymentRequired(exactChallenge()),
    invalid(
      exactChallenge({
        extra: { feePayer: rotatedFeePayer, decimals: 6 },
      }),
    ),
    invalid(exactChallenge()),
  ]);
  const outcome = await payMove({
    claimId: "clm_1",
    moveUci: "e2e4",
    address: payer.addr.toString(),
    stakeMicroUsdc: 1_000,
    meta: exactMeta,
    client,
    getSigner,
  });
  expect(outcome.kind).toBe("failed");
  expect(getSigner).toHaveBeenCalledTimes(2);

  for (const failure of [
    {
      kind: "payment_failed" as const,
      code: "INSUFFICIENT_FUNDS" as const,
      envelope: { error: "INSUFFICIENT_FUNDS", hint: "fund", docs: "" },
      challengeHeader: exactChallenge(),
    },
    {
      kind: "payment_failed" as const,
      code: "NOT_OPTED_IN" as const,
      envelope: { error: "NOT_OPTED_IN", hint: "opt in", docs: "" },
      challengeHeader: exactChallenge(),
    },
    { kind: "unavailable" as const, retryAfterSeconds: 5 },
  ]) {
    resetHeaderCacheForTests();
    const signer = vi.fn(async () => exactWallet());
    const single = scriptedClient([paymentRequired(exactChallenge()), failure]);
    await payMove({
      claimId: "clm_1",
      moveUci: "e2e4",
      address: payer.addr.toString(),
      stakeMicroUsdc: 1_000,
      meta: exactMeta,
      client: single,
      getSigner: signer,
    });
    expect(signer).toHaveBeenCalledTimes(1);
    expect(single.calls).toHaveLength(2);
  }
});

it("web_mock_and_demo_paths_remain_wallet_free_and_release3_compatible", async () => {
  const getSigner = vi.fn(async () => exactWallet());
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const client = scriptedClient([challenge402, { kind: "receipt", receipt }]);
  await expect(
    payMove({
      claimId: "clm_1",
      moveUci: "e2e4",
      address: "PLAYER",
      stakeMicroUsdc: 1_000,
      meta,
      client,
      getSigner,
    }),
  ).resolves.toEqual({ kind: "receipt", receipt });
  expect(getSigner).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});
