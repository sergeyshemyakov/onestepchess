import { Buffer } from "node:buffer";
import {
  MOVE_RESOURCE_DESCRIPTION,
  MOVE_RESOURCE_MIME_TYPE,
  moveBazaarExtensions,
  X402_GLOBAL_CHALLENGE_TAG,
} from "@onestepchess/core";
import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import {
  buildMockHeader,
  createMockRail,
  createMockRailState,
  MOCK_NETWORK,
  MOCK_SCHEME,
} from "./index.js";

const RESOURCE = "https://osc.example/api/v1/claims/claim-1/move";

function payment(
  rail: ReturnType<typeof createMockRail>,
  nonce: string,
  amount = 1_000,
) {
  const challenge = rail.buildPaymentChallenge({
    amountMicroUsdc: amount,
    resource: RESOURCE,
  });
  return {
    challenge,
    header: buildMockHeader({ challenge, from: "PLAYER_A", nonce }),
  };
}

describe("rail-mock clean path", () => {
  it("clean-path end-to-end sequence uses sequential ids and truthful treasury echo memory", async () => {
    const rail = createMockRail({
      initialTreasury: { usdcMicroUsdc: 2_000, algoMicroAlgo: 900 },
    });
    const { challenge, header } = payment(rail, "clean", 1_000);

    expect(rail.decodePayment(header)).toEqual({
      ok: true,
      payment: {
        clientTxId: "mockpay_clean",
        sender: "PLAYER_A",
        amountMicroUsdc: 1_000,
        asset: "31566704",
        payTo: "MOCK_TREASURY",
        lastValidRound: null,
      },
    });
    await expect(rail.verify(header, challenge.required)).resolves.toEqual({
      ok: true,
    });
    const settled = await rail.settle(header, challenge.required);
    expect(settled).toMatchObject({
      ok: true,
      txid: "mocktx_000001",
      confirmedRound: 1_000,
    });

    const prepared = await rail.preparePayouts([
      { jobId: "job-a", recipient: "WINNER_A", amountMicroUsdc: 300 },
      { jobId: "job-b", recipient: "WINNER_B", amountMicroUsdc: 200 },
    ]);
    expect(prepared.txids).toEqual([
      { jobId: "job-a", txid: "mocktx_000002" },
      { jobId: "job-b", txid: "mocktx_000003" },
    ]);
    await expect(rail.getBalances(rail.treasuryAddress)).resolves.toEqual({
      usdcMicroUsdc: 3_000,
      algoMicroAlgo: 900,
    });
    await expect(rail.submitPrepared(prepared)).resolves.toEqual({ ok: true });
    await expect(rail.getTransactionStatus("mockpay_clean")).resolves.toEqual({
      status: "confirmed",
      confirmedRound: 1_000,
    });
    await expect(
      rail.getTransactionStatus("mocktx_000002"),
    ).resolves.toMatchObject({
      status: "confirmed",
    });
    await expect(rail.findPayoutByNote("job-a")).resolves.toMatchObject({
      txid: "mocktx_000002",
    });
    await expect(rail.getBalances(rail.treasuryAddress)).resolves.toEqual({
      usdcMicroUsdc: 2_500,
      algoMicroAlgo: 900,
    });
  });

  it("header round-trip preserves fields, anchors repeat bytes, and gives fresh nonces new anchors", () => {
    const rail = createMockRail();
    const challenge = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: RESOURCE,
    });
    const first = buildMockHeader({
      challenge,
      from: "PLAYER_A",
      nonce: "fixed",
    });
    const freshA = buildMockHeader({ challenge, from: "PLAYER_A" });
    const freshB = buildMockHeader({ challenge, from: "PLAYER_A" });

    expect(rail.decodePayment(first)).toEqual(rail.decodePayment(first));
    expect(rail.decodePayment(first)).toMatchObject({
      ok: true,
      payment: {
        clientTxId: "mockpay_fixed",
        sender: "PLAYER_A",
        amountMicroUsdc: 1_000,
        asset: "31566704",
        payTo: "MOCK_TREASURY",
        lastValidRound: null,
      },
    });
    expect(rail.decodePayment(freshA)).not.toEqual(rail.decodePayment(freshB));
  });

  it("malformed payment matrix always returns malformed and never throws", () => {
    const rail = createMockRail();
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64");
    const malformed = [
      "%%%not-base64%%%",
      Buffer.from("not json").toString("base64"),
      encode({}),
      encode({ x402Version: 2, resource: { url: RESOURCE } }),
      encode({
        x402Version: 2,
        resource: { url: RESOURCE },
        accepted: {
          scheme: MOCK_SCHEME,
          network: MOCK_NETWORK,
          asset: "31566704",
          amount: "1000",
          payTo: "MOCK_TREASURY",
          maxTimeoutSeconds: 120,
          extra: {},
        },
        payload: { from: "PLAYER_A" },
      }),
    ];

    for (const header of malformed) {
      expect(() => rail.decodePayment(header)).not.toThrow();
      expect(rail.decodePayment(header)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("verify rejects a well-formed header bound to a different resource", async () => {
    const rail = createMockRail();
    const expected = payment(rail, "bound");
    const otherChallenge = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: "https://osc.example/api/v1/claims/other/move",
    });
    const wrongResource = buildMockHeader({
      challenge: otherChallenge,
      from: "PLAYER_A",
      nonce: "bound",
    });

    await expect(
      rail.verify(wrongResource, expected.challenge.required),
    ).resolves.toEqual({ ok: false, reason: "invalid_payment" });
  });

  it("mock PAYMENT-REQUIRED header matches the pinned golden fixture", () => {
    const rail = createMockRail({ treasuryAddress: "TREASURY_FIXTURE" });
    const challenge = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: RESOURCE,
    });

    expect(
      JSON.parse(Buffer.from(challenge.header, "base64").toString("utf8")),
    ).toEqual({
      x402Version: 2,
      resource: {
        url: RESOURCE,
        description: MOVE_RESOURCE_DESCRIPTION,
        mimeType: MOVE_RESOURCE_MIME_TYPE,
      },
      accepts: [
        {
          scheme: "mock",
          network: "mock:local",
          asset: "31566704",
          amount: "1000",
          payTo: "TREASURY_FIXTURE",
          maxTimeoutSeconds: 120,
          extra: { tag: X402_GLOBAL_CHALLENGE_TAG },
        },
      ],
      extensions: moveBazaarExtensions(),
    });
  });

  it("shared MockRailState preserves txids and balances across rail instances", async () => {
    const state = createMockRailState(
      { usdcMicroUsdc: 100, algoMicroAlgo: 200 },
      { usdcMicroUsdc: 60, algoMicroAlgo: 40 },
    );
    const first = createMockRail({ state });
    const paid = payment(first, "restart", 50);
    const settled = await first.settle(paid.header, paid.challenge.required);
    const prepared = await first.prepareFunding({
      player: "PLAYER_B",
      leg: "usdc",
      amount: 20,
    });
    await first.submitPrepared(prepared);

    const restarted = createMockRail({ state });
    await expect(
      restarted.getBalances(restarted.treasuryAddress),
    ).resolves.toEqual({
      usdcMicroUsdc: 150,
      algoMicroAlgo: 200,
    });
    await expect(
      restarted.getBalances(restarted.bonusAddress),
    ).resolves.toEqual({
      usdcMicroUsdc: 40,
      algoMicroAlgo: 40,
    });
    if (!settled.ok) throw new Error("expected settlement success");
    await expect(
      restarted.getTransactionStatus(settled.txid),
    ).resolves.toMatchObject({
      status: "confirmed",
    });
    await expect(
      restarted.findFundingByNote("PLAYER_B", "usdc"),
    ).resolves.toMatchObject({
      txid: "mocktx_000002",
    });
    await expect(
      restarted.submitSignedTransaction("signed-placeholder"),
    ).resolves.toEqual({
      ok: true,
      txid: "mocktx_000003",
    });
  });

  it("two identical runs produce byte-identical traces", async () => {
    async function run(): Promise<string> {
      const rail = createMockRail({
        initialTreasury: { usdcMicroUsdc: 1_000 },
      });
      const paid = payment(rail, "deterministic", 250);
      const settlement = await rail.settle(
        paid.header,
        paid.challenge.required,
      );
      const prepared = await rail.preparePayouts([
        { jobId: "job", recipient: "WINNER", amountMicroUsdc: 100 },
      ]);
      const submitted = await rail.submitPrepared(prepared);
      const balances = await rail.getBalances(rail.treasuryAddress);
      return JSON.stringify({
        paid,
        settlement,
        prepared,
        submitted,
        balances,
      });
    }

    expect(await run()).toBe(await run());
  });

  it("buildPaymentChallenge is always ready without a health warm-up", () => {
    const rail = createMockRail();
    expect(() =>
      rail.buildPaymentChallenge({ amountMicroUsdc: 1, resource: RESOURCE }),
    ).not.toThrow();
  });
});

describe("rail-mock welcome-bonus sweep", () => {
  const player = algosdk.encodeAddress(new Uint8Array(32).fill(3));

  it("builds a full-USDC leg and a fee-net ALGO leg to the bonus address", async () => {
    const rail = createMockRail();
    rail.control.balanceOverrides.set(player, {
      usdcMicroUsdc: 150_000,
      algoMicroAlgo: 300_000,
    });
    rail.control.accountOverrides.set(player, {
      exists: true,
      optedInUsdc: true,
      spendableAlgoMicro: 200_000,
    });
    const quote = await rail.buildSweepTxns(player);
    expect(quote.receiver).toBe(rail.bonusAddress);
    expect(quote.txns.map(({ leg, amount }) => ({ leg, amount }))).toEqual([
      { leg: "usdc", amount: 150_000 },
      { leg: "algo", amount: 198_000 },
    ]);
    for (const txn of quote.txns) {
      const decoded = algosdk.decodeUnsignedTransaction(
        new Uint8Array(Buffer.from(txn.unsignedTxnB64, "base64")),
      );
      expect(decoded.sender.toString()).toBe(player);
      expect(decoded.fee).toBe(1_000n);
    }
  });

  it("quotes nothing when the account cannot cover a flat fee", async () => {
    const rail = createMockRail();
    rail.control.balanceOverrides.set(player, {
      usdcMicroUsdc: 150_000,
      algoMicroAlgo: 100_500,
    });
    rail.control.accountOverrides.set(player, {
      exists: true,
      optedInUsdc: true,
      spendableAlgoMicro: 500,
    });
    await expect(rail.buildSweepTxns(player)).resolves.toEqual({
      receiver: rail.bonusAddress,
      txns: [],
    });
  });

  it("relaying signed sweep legs credits the bonus account and debits the player", async () => {
    const rail = createMockRail();
    rail.control.balanceOverrides.set(player, {
      usdcMicroUsdc: 150_000,
      algoMicroAlgo: 300_000,
    });
    rail.control.accountOverrides.set(player, {
      exists: true,
      optedInUsdc: true,
      spendableAlgoMicro: 200_000,
    });
    const quote = await rail.buildSweepTxns(player);
    const key = algosdk.generateAccount();
    const bonusBefore = await rail.getBalances(rail.bonusAddress);
    for (const txn of quote.txns) {
      const decoded = algosdk.decodeUnsignedTransaction(
        new Uint8Array(Buffer.from(txn.unsignedTxnB64, "base64")),
      );
      // The mock relay only decodes — any Ed25519 signature works here.
      const signed = decoded.signTxn(key.sk);
      const result = await rail.submitSignedTransaction(
        Buffer.from(signed).toString("base64"),
      );
      expect(result.ok).toBe(true);
    }
    const bonusAfter = await rail.getBalances(rail.bonusAddress);
    expect(bonusAfter.usdcMicroUsdc - bonusBefore.usdcMicroUsdc).toBe(150_000);
    expect(bonusAfter.algoMicroAlgo - bonusBefore.algoMicroAlgo).toBe(198_000);
    await expect(rail.getBalances(player)).resolves.toEqual({
      usdcMicroUsdc: 0,
      algoMicroAlgo: 101_000,
    });
  });
});
