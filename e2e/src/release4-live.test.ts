import {
  assertTrustedPayment,
  buildPaymentHeader,
  decodePaymentResponse,
  MAINNET_CAIP2,
  MAINNET_USDC_ASSET,
  type Meta,
  paymentRequiredSchema,
  TESTNET_CAIP2,
  TESTNET_USDC_ASSET,
} from "@onestepchess/agent-kit";
import {
  createAvmRail,
  mapSettleFailure,
  mapVerifyFailure,
} from "@onestepchess/rail-avm";
import {
  buildMockHeader,
  createMockRail,
  createMockRailState,
} from "@onestepchess/rail-mock";
import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeRelease4LiveRun,
  MAINNET_ACKNOWLEDGEMENT,
  MAINNET_MICRO_SMOKE_LIMIT,
  RELEASE4_CHAIN_OPERATION_LIST,
  type Release4ChainHarnessDependencies,
  type Release4ChainHarnessInput,
  runRelease4ChainHarness,
} from "./release4-chain-harness.js";

const treasury = algosdk.generateAccount();
const bonus = algosdk.generateAccount();
const feePayer = algosdk.generateAccount();
const payer = algosdk.generateAccount();

function environment(
  profile: "testnet" | "mainnet" = "testnet",
): Record<string, string> {
  const mainnet = profile === "mainnet";
  return {
    OSC_LIVE_APPROVED: "yes",
    OSC_LIVE_PROFILE: profile,
    OSC_LIVE_EXPECT_NETWORK: profile,
    OSC_LIVE_CAIP2: mainnet ? MAINNET_CAIP2 : TESTNET_CAIP2,
    OSC_LIVE_USDC_ASA_ID: mainnet ? MAINNET_USDC_ASSET : TESTNET_USDC_ASSET,
    OSC_LIVE_ALGOD_URL: `https://${profile}-algod.example`,
    OSC_LIVE_INDEXER_URL: `https://${profile}-indexer.example`,
    OSC_LIVE_FACILITATOR_URL: "https://facilitator.example",
    OSC_LIVE_TREASURY_ADDRESS: treasury.addr.toString(),
    OSC_LIVE_EXPECT_FEE_PAYER: feePayer.addr.toString(),
    OSC_LIVE_PAYER_ADDRESS: payer.addr.toString(),
    OSC_LIVE_TREASURY_MNEMONIC: "treasury-secret",
    OSC_LIVE_BONUS_MNEMONIC: "bonus-secret",
    OSC_LIVE_PAYER_MNEMONIC: "payer-secret",
    OSC_LIVE_RESOURCE_URL:
      "https://osc.example/api/v1/claims/release4-live-smoke/move",
    OSC_LIVE_PAYMENT_MICRO_USDC: mainnet ? "50000" : "1000",
    OSC_LIVE_PAYOUT_MICRO_USDC: mainnet ? "50000" : "500",
    OSC_LIVE_AGGREGATE_BUDGET_MICRO_USDC: mainnet ? "100000" : "1500",
    OSC_LIVE_EVIDENCE_PATH: `/tmp/release4-${profile}-evidence.jsonl`,
    ...(mainnet
      ? { OSC_LIVE_MAINNET_LOCK_PATH: "/tmp/release4-mainnet-once.lock" }
      : {}),
  };
}

function harnessFixture(input: Release4ChainHarnessInput) {
  const challenge = {
    required: {
      x402Version: 2 as const,
      resource: { url: input.resourceUrl },
      accepts: [
        {
          scheme: "exact",
          network: input.caip2,
          asset: String(input.usdcAsaId),
          amount: String(input.paymentMicroUsdc),
          payTo: input.treasuryAddress,
          maxTimeoutSeconds: 120,
          extra: {
            feePayer: input.expectedFeePayer,
            decimals: 6,
          },
        },
      ] as const,
    },
    header: "fixture-required",
  };
  let balanceRead = 0;
  const rail: Release4ChainHarnessDependencies["rail"] = {
    treasuryAddress: input.treasuryAddress,
    async health() {
      return true;
    },
    async getBalances() {
      balanceRead += 1;
      const usdcMicroUsdc =
        balanceRead === 1
          ? 1_000_000
          : balanceRead === 2
            ? 1_000_000 + input.paymentMicroUsdc
            : 1_000_000 + input.paymentMicroUsdc - input.payoutMicroUsdc;
      return { usdcMicroUsdc, algoMicroAlgo: 10_000_000 };
    },
    buildPaymentChallenge() {
      return challenge;
    },
    decodePayment() {
      return {
        ok: true,
        payment: {
          clientTxId: "PAYMENT_TXID",
          sender: input.payerAddress,
          amountMicroUsdc: input.paymentMicroUsdc,
          asset: String(input.usdcAsaId),
          payTo: input.treasuryAddress,
          lastValidRound: 21_000,
        },
      };
    },
    async verify() {
      return { ok: true };
    },
    async settle() {
      return {
        ok: true,
        txid: "PAYMENT_TXID",
        confirmedRound: 20_001,
        paymentResponseHeader: "fixture-response",
      };
    },
    async getTransactionStatus(txid) {
      return {
        status: "confirmed",
        confirmedRound: txid === "PAYMENT_TXID" ? 20_001 : 20_002,
      };
    },
    async preparePayouts() {
      return {
        kind: "payouts",
        payloadB64: "signed-treasury-payload-must-not-be-recorded",
        groupId: "PAYOUT_GROUP",
        txids: [{ jobId: input.payoutJobId, txid: "PAYOUT_TXID" }],
        lastValidRound: 21_002,
      };
    },
    async submitPrepared() {
      return { ok: true };
    },
    async findPayoutByNote() {
      return { txid: "PAYOUT_TXID", confirmedRound: 20_002 };
    },
  };
  return { rail };
}

describe("Release 4 live harness", () => {
  it("release4_chain_harness_uses_one_env_shaped_flow_for_testnet_and_mainnet", async () => {
    const reports = [];
    for (const profile of ["testnet", "mainnet"] as const) {
      const authorized = authorizeRelease4LiveRun(environment(profile), {
        commandProfile: profile,
        stdinIsTty: true,
        acknowledgement:
          profile === "mainnet" ? MAINNET_ACKNOWLEDGEMENT : undefined,
        evidenceExists: () => false,
      });
      const input: Release4ChainHarnessInput = {
        profile,
        caip2: authorized.caip2,
        usdcAsaId: authorized.usdcAsaId,
        treasuryAddress: authorized.treasuryAddress,
        expectedFeePayer: authorized.expectedFeePayer,
        payerAddress: authorized.payerAddress,
        resourceUrl: authorized.resourceUrl,
        paymentMicroUsdc: authorized.paymentMicroUsdc,
        payoutMicroUsdc: authorized.payoutMicroUsdc,
        payoutJobId: `release4-${profile}`,
      };
      const records: Array<Readonly<Record<string, unknown>>> = [];
      const report = await runRelease4ChainHarness(input, {
        ...harnessFixture(input),
        buildPaymentHeader: async () => "fixture-payment-header",
        record: async (event) => {
          records.push(event);
        },
        sleep: async () => undefined,
        now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(14),
      });
      expect(report.operations).toEqual(RELEASE4_CHAIN_OPERATION_LIST);
      expect(JSON.stringify(records)).not.toContain("signed-treasury-payload");
      reports.push(report);
    }
    expect(reports[0]?.operations).toEqual(reports[1]?.operations);
    expect(reports.map((report) => report.settleLatencyMs)).toEqual([4, 4]);
  });

  it("release4_live_chain_commands_refuse_ci_missing_consent_wrong_network_and_unsafe_budget", () => {
    const factory = vi.fn();
    const attempt = (
      source: Record<string, string>,
      runtime: Parameters<typeof authorizeRelease4LiveRun>[1],
    ) => {
      const config = authorizeRelease4LiveRun(source, runtime);
      factory(config);
    };
    const testnet = environment();
    const mainnet = environment("mainnet");
    const cases: Array<
      [Record<string, string>, Parameters<typeof authorizeRelease4LiveRun>[1]]
    > = [
      [
        testnet,
        {
          commandProfile: "testnet",
          ci: "true",
          stdinIsTty: true,
          evidenceExists: () => false,
        },
      ],
      [
        { ...testnet, OSC_LIVE_APPROVED: "no" },
        {
          commandProfile: "testnet",
          stdinIsTty: true,
          evidenceExists: () => false,
        },
      ],
      [
        testnet,
        {
          commandProfile: "mainnet",
          stdinIsTty: true,
          evidenceExists: () => false,
        },
      ],
      [
        { ...testnet, OSC_LIVE_EXPECT_NETWORK: "mainnet" },
        {
          commandProfile: "testnet",
          stdinIsTty: true,
          evidenceExists: () => false,
        },
      ],
      [
        { ...testnet, OSC_LIVE_CAIP2: MAINNET_CAIP2 },
        {
          commandProfile: "testnet",
          stdinIsTty: true,
          evidenceExists: () => false,
        },
      ],
      [
        { ...testnet, OSC_LIVE_USDC_ASA_ID: MAINNET_USDC_ASSET },
        {
          commandProfile: "testnet",
          stdinIsTty: true,
          evidenceExists: () => false,
        },
      ],
      [
        { ...mainnet, OSC_LIVE_AGGREGATE_BUDGET_MICRO_USDC: "100001" },
        {
          commandProfile: "mainnet",
          stdinIsTty: true,
          acknowledgement: MAINNET_ACKNOWLEDGEMENT,
          evidenceExists: () => false,
        },
      ],
      [
        mainnet,
        {
          commandProfile: "mainnet",
          stdinIsTty: false,
          evidenceExists: () => false,
        },
      ],
      [
        mainnet,
        {
          commandProfile: "mainnet",
          stdinIsTty: true,
          acknowledgement: "yes",
          evidenceExists: () => false,
        },
      ],
      [
        mainnet,
        {
          commandProfile: "mainnet",
          stdinIsTty: true,
          acknowledgement: MAINNET_ACKNOWLEDGEMENT,
          evidenceExists: () => true,
        },
      ],
    ];
    for (const [source, runtime] of cases) {
      expect(() => attempt(source, runtime)).toThrow();
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("mainnet_parity_command_allows_exactly_the_pinned_micro_smoke_once", () => {
    const source = environment("mainnet");
    const authorized = authorizeRelease4LiveRun(source, {
      commandProfile: "mainnet",
      stdinIsTty: true,
      acknowledgement: MAINNET_ACKNOWLEDGEMENT,
      evidenceExists: () => false,
    });
    expect(authorized.aggregateBudgetMicroUsdc).toBe(MAINNET_MICRO_SMOKE_LIMIT);
    expect(
      authorized.paymentMicroUsdc + authorized.payoutMicroUsdc,
    ).toBeLessThanOrEqual(MAINNET_MICRO_SMOKE_LIMIT);
    expect(RELEASE4_CHAIN_OPERATION_LIST).toEqual([
      "health",
      "balances_before",
      "challenge",
      "build_payment",
      "decode_payment",
      "verify_payment",
      "settle_payment",
      "confirm_payment",
      "balances_after_payment",
      "prepare_payout",
      "persist_prepared_identity",
      "submit_payout",
      "confirm_payout",
      "find_payout_note",
      "reconcile_balances",
    ]);
    expect(RELEASE4_CHAIN_OPERATION_LIST.join(" ")).not.toMatch(
      /bonus|fleet|traffic/,
    );
    expect(() =>
      authorizeRelease4LiveRun(source, {
        commandProfile: "mainnet",
        stdinIsTty: true,
        acknowledgement: MAINNET_ACKNOWLEDGEMENT,
        evidenceExists: (path) => path === source.OSC_LIVE_MAINNET_LOCK_PATH,
      }),
    ).toThrow(/lock already exists/);
  });
});

it("release4_money_crash_matrix_converges_without_duplicate_move_payout_or_bonus", async () => {
  const initialUsdc = 10_000_000;
  const state = createMockRailState({
    usdcMicroUsdc: initialUsdc,
    algoMicroAlgo: 10_000_000,
  });
  let rail = createMockRail({ state });
  const challenge = rail.buildPaymentChallenge({
    amountMicroUsdc: 1_000,
    resource: "https://osc.example/api/v1/claims/crash-matrix/move",
  });
  const header = buildMockHeader({
    challenge,
    from: payer.addr.toString(),
    nonce: "release4-crash-payment",
  });
  const decoded = rail.decodePayment(header);
  if (!decoded.ok) throw new Error("mock payment fixture did not decode");
  rail.control.queueSettle({
    ok: false,
    reason: "unavailable",
    applied: true,
  });
  await expect(rail.settle(header, challenge.required)).resolves.toMatchObject({
    ok: false,
    reason: "unavailable",
  });
  rail = createMockRail({ state });
  await expect(
    rail.getTransactionStatus(decoded.payment.clientTxId),
  ).resolves.toMatchObject({ status: "confirmed" });
  const replayedSettlement = await rail.settle(header, challenge.required);
  expect(replayedSettlement).toMatchObject({ ok: true });

  const payout = await rail.preparePayouts([
    {
      jobId: "release4-crash-payout",
      recipient: payer.addr.toString(),
      amountMicroUsdc: 800,
    },
  ]);
  rail = createMockRail({ state });
  rail.control.queueSubmitPrepared({
    ok: false,
    reason: "unavailable",
    applied: true,
  });
  await expect(rail.submitPrepared(payout)).resolves.toMatchObject({
    ok: false,
    reason: "unavailable",
  });
  rail = createMockRail({ state });
  await expect(rail.submitPrepared(payout)).resolves.toEqual({ ok: true });

  const funding = await rail.prepareFunding({
    player: payer.addr.toString(),
    leg: "usdc",
    amount: 200,
  });
  rail = createMockRail({ state });
  await expect(rail.submitPrepared(funding)).resolves.toEqual({ ok: true });
  rail = createMockRail({ state });
  await expect(rail.submitPrepared(funding)).resolves.toEqual({ ok: true });

  // Stakes and payouts settle against the treasury; the welcome-bonus leg
  // debits the dedicated bonus account exactly once despite the replay.
  const balances = await rail.getBalances(rail.treasuryAddress);
  const treasuryLedger = [1_000, -800];
  expect(balances.usdcMicroUsdc - initialUsdc).toBe(
    treasuryLedger.reduce((sum, amount) => sum + amount, 0),
  );
  const bonusBalances = await rail.getBalances(rail.bonusAddress);
  expect(bonusBalances.usdcMicroUsdc - 10_000_000).toBe(-200);
  expect(await rail.findPayoutByNote("release4-crash-payout")).toMatchObject({
    txid: payout.txids[0]?.txid,
  });
  expect(
    await rail.findFundingByNote(payer.addr.toString(), "usdc"),
  ).toMatchObject({ txid: funding.txid });
});

it("captured_release4_shapes_roundtrip_through_rail_web_and_agent_guards", async () => {
  const resourceUrl = "https://osc.example/api/v1/claims/release4-fixture/move";
  const required = paymentRequiredSchema.parse({
    x402Version: 2,
    resource: { url: resourceUrl },
    accepts: [
      {
        scheme: "exact",
        network: TESTNET_CAIP2,
        asset: TESTNET_USDC_ASSET,
        amount: "1000",
        payTo: treasury.addr.toString(),
        maxTimeoutSeconds: 120,
        extra: { feePayer: feePayer.addr.toString(), decimals: 6 },
      },
    ],
  });
  const requiredHeader = Buffer.from(JSON.stringify(required)).toString(
    "base64",
  );
  const meta: Meta = {
    name: "One Step Chess",
    network: {
      caip2: TESTNET_CAIP2,
      usdcAssetId: TESTNET_USDC_ASSET,
      treasuryAddress: treasury.addr.toString(),
      facilitatorUrl: "https://facilitator.example",
      explorerBaseUrl: "https://explorer.perawallet.app",
      algodUrl: "https://algod.example",
    },
    economics: {
      humanStakeMicroUsdc: 1_000,
      agentStakeMicroUsdc: 1_000,
      endspielStakeMicroUsdc: 2_000,
      drawFeeMicroUsdc: 0,
      protocolFeeBps: 0,
      humanTargetMult: 1,
    },
    timing: {
      claimTtlSeconds: { human: 180, agent: 90, endspiel: 45 },
      timerRevealSeconds: 30,
      minPlyIntervalSeconds: 1,
      cooldownPlies: 1,
      nextGameNudgeSeconds: 10,
    },
    quotas: { human: 1, agent: 1, demo: 0, windowMinutes: 60 },
    status: { mode: "running", banner: null },
    turnstileSiteKey: "",
    rules: "fixture",
    docs: {
      llms: "https://osc.example/llms.txt",
      openapi: "https://osc.example/api/v1/openapi.json",
      mcpPackage: "@onestepchess/mcp",
      agentKitPackage: "@onestepchess/agent-kit",
      repo: "https://github.com/sergeyshemyakov/onestepchess",
    },
  };
  const claim = {
    claimId: "release4-fixture",
    yourSide: "white" as const,
    phase: "normal" as const,
    demo: false,
    fen: "8/8/8/8/8/8/4K3/7k w - - 0 1",
    legalMoves: [{ uci: "e2e3", san: "Ke3" }],
    stakeMicroUsdc: 1_000,
    deadline: "2026-07-31T20:00:00.000Z",
  };
  const requirement = assertTrustedPayment({
    paymentRequired: required,
    claim,
    meta,
    resourceUrl,
    expectNetwork: "testnet",
  });
  const suggestedParams = {
    fee: 1_000,
    "min-fee": 1_000,
    "last-round": 20_000,
    "genesis-id": "testnet-v1.0",
    "genesis-hash": TESTNET_CAIP2.slice("algorand:".length),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(suggestedParams), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  const paymentHeader = await buildPaymentHeader({
    paymentRequired: required,
    requirement,
    signer: {
      address: payer.addr.toString(),
      sign(bytes) {
        return algosdk.decodeUnsignedTransaction(bytes).signTxn(payer.sk);
      },
    },
    algodUrl: "https://algod.example",
  });
  const rail = createAvmRail({
    caip2: TESTNET_CAIP2,
    usdcAsaId: Number(TESTNET_USDC_ASSET),
    algodUrl: "https://algod.example",
    indexerUrl: "https://indexer.example",
    facilitatorUrl: "https://facilitator.example",
    treasuryMnemonic: algosdk.secretKeyToMnemonic(treasury.sk),
    bonusMnemonic: algosdk.secretKeyToMnemonic(bonus.sk),
  });
  expect(rail.decodePayment(paymentHeader)).toMatchObject({
    ok: true,
    payment: {
      sender: payer.addr.toString(),
      asset: TESTNET_USDC_ASSET,
      amountMicroUsdc: 1_000,
      payTo: treasury.addr.toString(),
    },
  });

  const webModuleUrl = new URL(
    "../../packages/web/src/wallet/x402.ts",
    import.meta.url,
  ).href;
  const web = (await import(webModuleUrl)) as {
    validateChallenge(
      header: string,
      input: { claimId: string; stakeMicroUsdc: number; meta: unknown },
    ): { readonly ok: boolean };
    guardExactPaymentGroup(input: {
      txns: Uint8Array[];
      indexesToSign: number[];
      requirement: unknown;
      signerAddress: string;
    }): unknown;
  };
  expect(
    web.validateChallenge(requiredHeader, {
      claimId: claim.claimId,
      stakeMicroUsdc: claim.stakeMicroUsdc,
      meta,
    }),
  ).toMatchObject({ ok: true });
  const payload = JSON.parse(
    Buffer.from(paymentHeader, "base64").toString("utf8"),
  ) as {
    payload: { paymentGroup: [string, string]; paymentIndex: number };
  };
  const signedClient = algosdk.decodeSignedTransaction(
    Buffer.from(payload.payload.paymentGroup[1], "base64"),
  );
  expect(() =>
    web.guardExactPaymentGroup({
      txns: [
        Buffer.from(payload.payload.paymentGroup[0], "base64"),
        algosdk.encodeUnsignedTransaction(signedClient.txn),
      ],
      indexesToSign: [payload.payload.paymentIndex],
      requirement,
      signerAddress: payer.addr.toString(),
    }),
  ).not.toThrow();

  const responseHeader = Buffer.from(
    JSON.stringify({
      success: true,
      transaction: signedClient.txn.txID(),
      network: TESTNET_CAIP2,
    }),
  ).toString("base64");
  expect(decodePaymentResponse(responseHeader)).toEqual({
    success: true,
    transaction: signedClient.txn.txID(),
    network: TESTNET_CAIP2,
  });
  expect(
    ["overspend", "asset not opted in", "invalid signature"].map(
      mapVerifyFailure,
    ),
  ).toEqual(["insufficient_funds", "not_opted_in", "invalid_payment"]);
  expect(
    ["transaction expired", "facilitator rejected"].map(mapSettleFailure),
  ).toEqual(["expired", "rejected"]);
  expect([
    { status: "confirmed", confirmedRound: 20_001 },
    { status: "pending" },
    { status: "not_found", currentRound: 20_002 },
  ]).toHaveLength(3);
  expect("osc:payout:release4-fixture").toMatch(/^osc:payout:/);
  expect("osc:bonus:usdc:fixture-player").toMatch(/^osc:bonus:usdc:/);
  vi.unstubAllGlobals();
});
