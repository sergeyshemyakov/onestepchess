import algosdk from "algosdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTrustedPayment,
  BudgetGuard,
  buildPaymentHeader,
  createOscClient,
  decodePaymentRequired,
  type Meta,
  type PaymentRequired,
  type Signer,
  TESTNET_CAIP2,
  TESTNET_USDC_ASSET,
} from "./index.js";

const at = "2026-07-25T12:00:00.000Z";
const payer = algosdk.generateAccount();
const treasury = algosdk.generateAccount();
const feePayer = algosdk.generateAccount();
const moveUrl = "https://osc.example/api/v1/claims/clm_pay/move";
const MOVE_DESCRIPTION =
  "Submit one legal move to an active shared One Step Chess game and receive the committed move and Algorand settlement receipt.";
const claim = {
  claimId: "clm_pay",
  yourSide: "white" as const,
  phase: "normal" as const,
  demo: false,
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  legalMoves: [{ uci: "e2e4", san: "e4" }],
  stakeMicroUsdc: 1000,
  deadline: "2026-07-25T12:01:30.000Z",
};
const receipt = {
  status: "moved" as const,
  move: { uci: "e2e4", san: "e4" },
  debitMicroUsdc: 1000,
  txid: "mocktx_1",
  explorerUrl: null,
  fenAfterYourMove:
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
};

function paymentExtensions() {
  return {
    bazaar: {
      info: {
        input: {
          type: "http" as const,
          method: "POST" as const,
          bodyType: "json" as const,
          body: { move: "e2e4" },
        },
        output: { type: "json" as const, example: receipt },
      },
      schema: {
        type: "object" as const,
        properties: { input: {}, output: {} },
        required: ["input", "output"],
        additionalProperties: false as const,
      },
    },
  };
}
const mockMeta: Meta = {
  name: "One Step Chess",
  network: {
    caip2: "mock:local",
    usdcAssetId: "31566704",
    treasuryAddress: treasury.addr.toString(),
    facilitatorUrl: "https://facilitator.example",
    explorerBaseUrl: "https://explorer.example",
    algodUrl: "https://algod.example",
  },
  economics: {
    humanStakeMicroUsdc: 1000,
    agentStakeMicroUsdc: 1000,
    endspielStakeMicroUsdc: 2000,
    drawFeeMicroUsdc: 0,
    protocolFeeBps: 250,
    humanTargetMult: 1.5,
  },
  timing: {
    claimTtlSeconds: { human: 180, agent: 90, endspiel: 45 },
    timerRevealSeconds: 30,
    minPlyIntervalSeconds: 10,
    cooldownPlies: 4,
    nextGameNudgeSeconds: 15,
  },
  quotas: { human: 10, agent: 100, demo: 1, windowMinutes: 60 },
  status: { mode: "running", banner: null },
  turnstileSiteKey: "site",
  rules: "one move",
  docs: {
    llms: "https://osc.example/llms.txt",
    openapi: "https://osc.example/api/v1/openapi.json",
    mcpPackage: "@onestepchess/mcp",
    agentKitPackage: "@onestepchess/agent-kit",
    repo: "https://github.com/sergeyshemyakov/onestepchess",
  },
};

function paymentRequired(
  changes: Partial<PaymentRequired["accepts"][number]> = {},
): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: moveUrl,
      description: MOVE_DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "mock",
        network: "mock:local",
        asset: "31566704",
        amount: "1000",
        payTo: treasury.addr.toString(),
        maxTimeoutSeconds: 120,
        extra: { tag: "x402-global-challenge" },
        ...changes,
      },
    ],
    extensions: paymentExtensions(),
  };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function authChallenge(): object {
  const nonce = "pay-auth";
  const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: payer.addr,
    amount: 0,
    note: new TextEncoder().encode(`osc-auth:${nonce}`),
    suggestedParams: {
      flatFee: true,
      fee: 0,
      minFee: 1000,
      firstValid: 1,
      lastValid: 1,
      genesisID: "mainnet-v1.0",
      genesisHash: Buffer.alloc(32, 1),
    },
  });
  return {
    nonce,
    expiresAt: "2026-07-25T12:05:00.000Z",
    arc60Payload: {
      data: "e30=",
      metadata: { scope: 1, encoding: "base64" },
    },
    fallbackTxnB64: Buffer.from(
      algosdk.encodeUnsignedTransaction(transaction),
    ).toString("base64"),
  };
}

function accountSigner(spy = vi.fn()): Signer {
  return {
    address: payer.addr.toString(),
    sign(bytes) {
      spy(bytes);
      return algosdk.decodeUnsignedTransaction(bytes).signTxn(payer.sk);
    },
  };
}

type MoveServerMode =
  | "lost_then_receipt"
  | "lost_200"
  | "pending"
  | "inflight"
  | "expired"
  | "invalid_then_receipt"
  | "funds"
  | "optin"
  | "unavailable";

function moveServer(mode: MoveServerMode) {
  const paidHeaders: string[] = [];
  let paidCalls = 0;
  let statusCalls = 0;
  const freshRequired = paymentRequired();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const target = new URL(input.toString());
    const path = target.pathname;
    if (path.endsWith("/meta")) return json(mockMeta);
    if (path.endsWith("/auth/challenge")) return json(authChallenge());
    if (path.endsWith("/auth/verify")) {
      return json({
        player: {
          address: payer.addr.toString(),
          kind: "agent",
          nickname: "payer",
          createdAt: at,
        },
        jwt: "jwt",
      });
    }
    if (path.endsWith("/claims/clm_pay/status")) {
      statusCalls += 1;
      if (mode === "lost_200" && statusCalls > 1) {
        return json({ status: "moved", receipt });
      }
      return json({
        status: "open",
        claim,
        paymentState:
          (mode === "lost_then_receipt" || mode === "pending") &&
          statusCalls > 1
            ? "settling"
            : null,
      });
    }
    if (path.endsWith("/claims/clm_pay/move")) {
      const header = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (header === null) {
        return json({ error: "PAYMENT_REQUIRED", hint: "pay", docs: "" }, 402, {
          "PAYMENT-REQUIRED": b64(freshRequired),
        });
      }
      paidCalls += 1;
      paidHeaders.push(header);
      if (mode === "lost_then_receipt" && paidCalls === 1) {
        throw new Error("lost response");
      }
      if (mode === "lost_200" && paidCalls === 1) {
        throw new Error("receipt lost after commit");
      }
      if (mode === "pending") {
        return json(
          { error: "PAYMENT_PENDING", hint: "pending", docs: "" },
          202,
          { "Retry-After": "1" },
        );
      }
      if (mode === "inflight" && paidCalls === 1) {
        return json(
          { error: "PAYMENT_IN_FLIGHT", hint: "in flight", docs: "" },
          409,
        );
      }
      if (mode === "expired") {
        return json({ error: "CLAIM_EXPIRED", hint: "expired", docs: "" }, 410);
      }
      if (mode === "invalid_then_receipt" && paidCalls === 1) {
        return json(
          { error: "PAYMENT_INVALID", hint: "rotated", docs: "" },
          402,
          { "PAYMENT-REQUIRED": b64(freshRequired) },
        );
      }
      const failure =
        mode === "funds"
          ? ["INSUFFICIENT_FUNDS", 402]
          : mode === "optin"
            ? ["NOT_OPTED_IN", 402]
            : mode === "unavailable"
              ? ["PAYMENT_UNAVAILABLE", 503]
              : null;
      if (failure !== null) {
        return json(
          { error: failure[0], hint: "definitive failure", docs: "" },
          failure[1] as number,
        );
      }
      return json(receipt, 200, {
        "PAYMENT-RESPONSE": b64({
          success: true,
          transaction: receipt.txid,
          network: "mock:local",
        }),
      });
    }
    throw new Error(`unexpected route ${target}`);
  });
  return {
    fetch,
    paidHeaders,
    get paidCalls() {
      return paidCalls;
    },
  };
}

describe("agent-kit payments and budgets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("agent_network_asset_resource_and_payto_pins_fail_before_signing_or_algod", async () => {
    const signing = vi.fn();
    const algod = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", algod);
    const signer: Signer = {
      address: payer.addr.toString(),
      sign: signing,
    };
    const symbolicMockTreasury = "MOCK_TREASURY";
    expect(
      assertTrustedPayment({
        paymentRequired: paymentRequired({ payTo: symbolicMockTreasury }),
        claim,
        meta: {
          ...mockMeta,
          network: {
            ...mockMeta.network,
            treasuryAddress: symbolicMockTreasury,
          },
        },
        resourceUrl: moveUrl,
        expectNetwork: "mock",
      }).payTo,
    ).toBe(symbolicMockTreasury);
    const cases: Array<{
      required?: PaymentRequired;
      meta?: Meta;
      resourceUrl?: string;
      expectNetwork?: "mainnet" | "testnet" | "mock";
    }> = [
      { required: paymentRequired({ amount: "999" }) },
      {
        required: {
          ...paymentRequired(),
          resource: { url: "https://evil.example/move" },
        },
      },
      { required: paymentRequired({ network: "algorand:unknown" }) },
      { required: paymentRequired({ asset: "999" }) },
      { required: paymentRequired({ payTo: payer.addr.toString() }) },
      { expectNetwork: "mainnet" },
      {
        required: paymentRequired({
          scheme: "exact",
          network: TESTNET_CAIP2,
          asset: TESTNET_USDC_ASSET,
          extra: { feePayer: "invalid" },
        }),
        meta: {
          ...mockMeta,
          network: {
            ...mockMeta.network,
            caip2: TESTNET_CAIP2,
            usdcAssetId: TESTNET_USDC_ASSET,
          },
        },
        expectNetwork: "testnet",
      },
    ];

    for (const item of cases) {
      await expect(async () => {
        const required = item.required ?? paymentRequired();
        const requirement = assertTrustedPayment({
          paymentRequired: required,
          claim,
          meta: item.meta ?? mockMeta,
          resourceUrl: item.resourceUrl ?? moveUrl,
          ...(item.expectNetwork === undefined
            ? {}
            : { expectNetwork: item.expectNetwork }),
        });
        await buildPaymentHeader({
          paymentRequired: required,
          requirement,
          signer,
        });
      }).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
    }
    expect(signing).not.toHaveBeenCalled();
    expect(algod).not.toHaveBeenCalled();
  });

  it("agent_budget_reserves_before_signing_and_accounts_once_per_claim", () => {
    const budget = new BudgetGuard({
      maxStakeMicroUsdc: 5000,
      sessionBudgetMicroUsdc: 10_000,
    });
    budget.reserve("clm_1", 5000);
    budget.reserve("clm_1", 5000);
    expect(budget.spent()).toBe(5000);
    budget.reserve("clm_2", 5000);
    expect(budget.remaining()).toBe(0);
    expect(() => budget.reserve("clm_3", 1)).toThrowError(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
    );
    expect(() =>
      new BudgetGuard({
        maxStakeMicroUsdc: 4999,
        sessionBudgetMicroUsdc: 10_000,
      }).reserve("edge", 5000),
    ).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    budget.release("clm_2");
    expect(budget.remaining()).toBe(5000);
    budget.reserve("clm_2", 5000);
    expect(budget.spent()).toBe(10_000);
    expect(() => budget.reserve("clm_1", 4999)).toThrowError(
      expect.objectContaining({ code: "NETWORK_MISMATCH" }),
    );
  });

  it("agent_mock_payment_matches_rail_v2_goldens_without_wallet_access", async () => {
    const signing = vi.fn();
    const required = paymentRequired();
    const header = await buildPaymentHeader({
      paymentRequired: required,
      requirement: required.accepts[0],
      signer: { address: payer.addr.toString(), sign: signing },
      nonce: () => "fixture-nonce",
    });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString());
    expect(decoded).toEqual({
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0],
      extensions: required.extensions,
      payload: {
        from: payer.addr.toString(),
        amountMicroUsdc: 1000,
        asset: "31566704",
        payTo: treasury.addr.toString(),
        nonce: "fixture-nonce",
      },
    });
    expect(`mockpay_${decoded.payload.nonce}`).toBe("mockpay_fixture-nonce");
    expect(signing).not.toHaveBeenCalled();
  });

  it("agent_bazaar_metadata_is_rejected_when_malformed_and_preserved_when_valid", async () => {
    const valid = paymentRequired();
    const extended = structuredClone(valid) as unknown as {
      extensions: {
        bazaar: {
          futureBazaarField?: string;
          info: { input: { futureInputField?: string } };
        };
      };
    };
    extended.extensions.bazaar.futureBazaarField = "preserve-me";
    extended.extensions.bazaar.info.input.futureInputField = "preserve-me-too";
    const decoded = decodePaymentRequired(b64(extended));
    expect(decoded.extensions).toMatchObject({
      bazaar: {
        futureBazaarField: "preserve-me",
        info: { input: { futureInputField: "preserve-me-too" } },
      },
    });

    const header = await buildPaymentHeader({
      paymentRequired: decoded,
      requirement: decoded.accepts[0],
      signer: accountSigner(),
      nonce: () => "bazaar-preservation",
    });
    expect(
      JSON.parse(Buffer.from(header, "base64").toString("utf8")).extensions,
    ).toEqual(decoded.extensions);

    const malformed = structuredClone(valid) as unknown as {
      extensions: { bazaar: { info: { input: { method: string } } } };
    };
    malformed.extensions.bazaar.info.input.method = "GET";
    expect(() => decodePaymentRequired(b64(malformed))).toThrowError(
      expect.objectContaining({ code: "NETWORK_MISMATCH" }),
    );
  });

  it("agent_budget_and_payment_cache_survive_every_exact_retry_branch_without_double_reservation_or_resign", async () => {
    const server = moveServer("lost_then_receipt");
    const signing = vi.fn();
    const budget = new BudgetGuard();
    const client = createOscClient({
      serverUrl: "https://osc.example",
      signer: accountSigner(signing),
      fetch: server.fetch,
      budget,
      nonce: () => "one-signature",
    });
    await expect(client.move(claim.claimId, "e4")).resolves.toEqual(receipt);
    expect(server.paidHeaders).toHaveLength(2);
    expect(server.paidHeaders[0]).toBe(server.paidHeaders[1]);
    expect(signing).toHaveBeenCalledTimes(1);
    expect(budget.spent()).toBe(1000);

    const inflight = moveServer("inflight");
    const inflightBudget = new BudgetGuard();
    await expect(
      createOscClient({
        serverUrl: "https://osc.example",
        signer: accountSigner(),
        fetch: inflight.fetch,
        budget: inflightBudget,
        nonce: () => "inflight-once",
      }).move(claim.claimId, "e4"),
    ).resolves.toEqual(receipt);
    expect(inflight.paidHeaders).toHaveLength(2);
    expect(new Set(inflight.paidHeaders).size).toBe(1);
    expect(inflightBudget.spent()).toBe(1000);

    const lost = moveServer("lost_200");
    const lostBudget = new BudgetGuard();
    await expect(
      createOscClient({
        serverUrl: "https://osc.example",
        signer: accountSigner(),
        fetch: lost.fetch,
        budget: lostBudget,
        nonce: () => "lost-200-once",
      }).move(claim.claimId, "e4"),
    ).resolves.toEqual(receipt);
    expect(lost.paidCalls).toBe(1);
    expect(lostBudget.spent()).toBe(1000);

    const pending = moveServer("pending");
    const pendingBudget = new BudgetGuard();
    await expect(
      createOscClient({
        serverUrl: "https://osc.example",
        signer: accountSigner(),
        fetch: pending.fetch,
        budget: pendingBudget,
        nonce: () => "pending-once",
      }).move(claim.claimId, "e4"),
    ).rejects.toMatchObject({ code: "PAYMENT_PENDING" });
    expect(pending.paidCalls).toBe(1);
    expect(pendingBudget.spent()).toBe(1000);

    const expired = moveServer("expired");
    const expiredBudget = new BudgetGuard();
    await expect(
      createOscClient({
        serverUrl: "https://osc.example",
        signer: accountSigner(),
        fetch: expired.fetch,
        budget: expiredBudget,
        nonce: () => "expired-once",
      }).move(claim.claimId, "e4"),
    ).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    expect(expiredBudget.spent()).toBe(0);
  });

  it("agent_payment_rebuilds_once_only_for_payment_invalid", async () => {
    const invalid = moveServer("invalid_then_receipt");
    const nonce = vi
      .fn<() => string>()
      .mockReturnValueOnce("first")
      .mockReturnValueOnce("second");
    const budget = new BudgetGuard();
    const client = createOscClient({
      serverUrl: "https://osc.example",
      signer: accountSigner(),
      fetch: invalid.fetch,
      budget,
      nonce,
    });
    await expect(client.move(claim.claimId, "e4")).resolves.toEqual(receipt);
    expect(invalid.paidHeaders).toHaveLength(2);
    expect(invalid.paidHeaders[0]).not.toBe(invalid.paidHeaders[1]);
    expect(nonce).toHaveBeenCalledTimes(2);
    expect(budget.spent()).toBe(1000);

    for (const mode of ["funds", "optin", "unavailable"] as const) {
      const server = moveServer(mode);
      const guardedBudget = new BudgetGuard();
      await expect(
        createOscClient({
          serverUrl: "https://osc.example",
          signer: accountSigner(),
          fetch: server.fetch,
          budget: guardedBudget,
          nonce: () => "only",
        }).move(claim.claimId, "e4"),
      ).rejects.toMatchObject({
        code:
          mode === "funds"
            ? "INSUFFICIENT_FUNDS"
            : mode === "optin"
              ? "NOT_OPTED_IN"
              : "PAYMENT_UNAVAILABLE",
      });
      expect(server.paidCalls).toBe(1);
      expect(guardedBudget.spent()).toBe(0);
    }
  });

  it("agent_exact_payment_matches_release4_group_and_header_fixtures", async () => {
    const exactMeta: Meta = {
      ...mockMeta,
      network: {
        ...mockMeta.network,
        caip2: TESTNET_CAIP2,
        usdcAssetId: TESTNET_USDC_ASSET,
      },
    };
    const required: PaymentRequired = {
      x402Version: 2,
      resource: {
        url: moveUrl,
        description: MOVE_DESCRIPTION,
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: TESTNET_CAIP2,
          asset: TESTNET_USDC_ASSET,
          amount: "1000",
          payTo: treasury.addr.toString(),
          maxTimeoutSeconds: 120,
          extra: {
            feePayer: feePayer.addr.toString(),
            decimals: 6,
            tag: "x402-global-challenge",
          },
        },
      ],
      extensions: paymentExtensions(),
    };
    const suggested = {
      fee: 1000,
      "min-fee": 1000,
      "last-round": 20_000,
      "genesis-id": "testnet-v1.0",
      "genesis-hash": TESTNET_CAIP2.slice(9),
    };
    const fetch = vi.fn(async () => json(suggested));
    vi.stubGlobal("fetch", fetch);
    const sign = vi.fn((bytes: Uint8Array) =>
      algosdk.decodeUnsignedTransaction(bytes).signTxn(payer.sk),
    );
    const requirement = assertTrustedPayment({
      paymentRequired: required,
      claim,
      meta: exactMeta,
      resourceUrl: moveUrl,
      expectNetwork: "testnet",
    });
    const header = await buildPaymentHeader({
      paymentRequired: required,
      requirement,
      signer: { address: payer.addr.toString(), sign },
      algodUrl: "https://algod.example",
    });
    const payload = JSON.parse(Buffer.from(header, "base64").toString());
    expect(payload.accepted).toEqual(required.accepts[0]);
    expect(payload.payload.paymentIndex).toBe(1);
    const feeTransaction = algosdk.decodeUnsignedTransaction(
      Buffer.from(payload.payload.paymentGroup[0], "base64"),
    );
    const paymentTransaction = algosdk.decodeSignedTransaction(
      Buffer.from(payload.payload.paymentGroup[1], "base64"),
    ).txn;
    expect(feeTransaction.sender.toString()).toBe(feePayer.addr.toString());
    expect(feeTransaction.payment?.receiver.toString()).toBe(
      feePayer.addr.toString(),
    );
    expect(feeTransaction.payment?.amount).toBe(0n);
    expect(paymentTransaction.sender.toString()).toBe(payer.addr.toString());
    expect(paymentTransaction.assetTransfer?.receiver.toString()).toBe(
      treasury.addr.toString(),
    );
    expect(paymentTransaction.assetTransfer?.amount).toBe(1000n);
    expect(paymentTransaction.assetTransfer?.assetIndex).toBe(
      BigInt(TESTNET_USDC_ASSET),
    );
    expect(paymentTransaction.fee).toBe(0n);
    expect(paymentTransaction.txID()).toMatch(/^[A-Z2-7]{52}$/);
    expect(paymentTransaction.lastValid - paymentTransaction.firstValid).toBe(
      1000n,
    );
    expect(
      Buffer.from(paymentTransaction.genesisHash ?? []).toString("base64"),
    ).toBe(TESTNET_CAIP2.slice(9));
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("agent_mock_move_charges_and_budgets_once_after_lost_response", async () => {
    const server = moveServer("lost_then_receipt");
    const budget = new BudgetGuard({
      maxStakeMicroUsdc: 1000,
      sessionBudgetMicroUsdc: 1000,
    });
    const client = createOscClient({
      serverUrl: "https://osc.example",
      signer: accountSigner(),
      fetch: server.fetch,
      budget,
      nonce: () => "durable-receipt",
    });
    const moved = await client.move(claim.claimId, "e2e4");
    expect(moved.txid).toBe("mocktx_1");
    expect(server.paidCalls).toBe(2);
    expect(new Set(server.paidHeaders).size).toBe(1);
    expect(budget.remaining()).toBe(0);
  });
});
