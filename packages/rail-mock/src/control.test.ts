import { RailError } from "@onestepchess/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildMockHeader,
  createMockRail,
  createMockRailState,
} from "./index.js";

const RESOURCE = "https://osc.example/api/v1/moves";

function payment(
  rail: ReturnType<typeof createMockRail>,
  nonce: string,
  amount = 100,
) {
  const challenge = rail.buildPaymentChallenge({
    amountMicroUsdc: amount,
    resource: RESOURCE,
  });
  return {
    challenge,
    header: buildMockHeader({ challenge, from: "PLAYER", nonce }),
  };
}

async function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RailError);
  expect(error).toMatchObject({ code: "UNAVAILABLE" });
}

describe("rail-mock control surface", () => {
  it("every queued control failure surfaces once and then reverts to defaults", async () => {
    const rail = createMockRail();
    const paidA = payment(rail, "queued-a");
    const paidB = payment(rail, "queued-b");
    rail.control.queueVerify({
      ok: false,
      reason: "unavailable",
      detail: "once",
    });
    await expect(
      rail.verify(paidA.header, paidA.challenge.required),
    ).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      detail: "once",
    });
    await expect(
      rail.verify(paidA.header, paidA.challenge.required),
    ).resolves.toEqual({ ok: true });

    rail.control.queueSettle({ ok: false, reason: "expired" });
    await expect(
      rail.settle(paidA.header, paidA.challenge.required),
    ).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
    await expect(
      rail.settle(paidA.header, paidA.challenge.required),
    ).resolves.toMatchObject({
      ok: true,
      txid: "mocktx_000001",
    });

    const prepared = await rail.preparePayouts([
      { jobId: "queued-job", recipient: "WINNER", amountMicroUsdc: 10 },
    ]);
    rail.control.queueSubmitPrepared({
      ok: false,
      reason: "rejected",
      detail: "once",
    });
    await expect(rail.submitPrepared(prepared)).resolves.toEqual({
      ok: false,
      reason: "rejected",
      detail: "once",
    });
    await expect(rail.submitPrepared(prepared)).resolves.toEqual({ ok: true });

    rail.control.queueSubmitSignedTransaction({
      ok: false,
      reason: "unavailable",
    });
    await expect(rail.submitSignedTransaction("signed-a")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(
      rail.submitSignedTransaction("signed-b"),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      rail.settle(paidB.header, paidB.challenge.required),
    ).resolves.toMatchObject({ ok: true });
  });

  it("a rejected submit with applied=true still lands the prepared bytes", async () => {
    const state = createMockRailState({ usdcMicroUsdc: 1_000_000 });
    const rail = createMockRail({ state, treasuryAddress: "MOCK_TREASURY" });
    const prepared = await rail.preparePayouts([
      { jobId: "dup-job", recipient: "WINNER", amountMicroUsdc: 500 },
    ]);
    rail.control.queueSubmitPrepared({
      ok: false,
      reason: "rejected",
      applied: true,
    });
    await expect(rail.submitPrepared(prepared)).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
    const balances = await rail.getBalances("MOCK_TREASURY");
    expect(balances.usdcMicroUsdc).toBe(1_000_000 - 500);
    const txid = prepared.txids[0]?.txid ?? "";
    await expect(rail.getTransactionStatus(txid)).resolves.toMatchObject({
      status: "confirmed",
    });
  });

  it("sticky and per-outcome latency use the injected sleep primitive", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const rail = createMockRail({ sleep });
    const paid = payment(rail, "latency");
    rail.control.setLatency({ verifyMs: 11, settleMs: 22 });
    rail.control.queueSettle({
      latencyMs: 33,
      // biome-ignore lint/suspicious/noThenProperty: Scripted<T> uses the rail spec's pinned wrapper shape.
      then: { ok: false, reason: "rejected" },
    });

    await rail.verify(paid.header, paid.challenge.required);
    await rail.verify(paid.header, paid.challenge.required);
    await rail.settle(paid.header, paid.challenge.required);
    await rail.settle(paid.header, paid.challenge.required);
    expect(sleep.mock.calls).toEqual([[11], [11], [33], [22]]);
  });

  it("failQueries throws UNAVAILABLE for each selected query family", async () => {
    const rail = createMockRail();
    rail.control.failQueries(["status", "note", "balances", "account"]);

    await expectUnavailable(rail.getTransactionStatus("unknown"));
    await expectUnavailable(rail.findPayoutByNote("job"));
    await expectUnavailable(rail.findFundingByNote("PLAYER", "algo"));
    await expectUnavailable(rail.getBalances("PLAYER"));
    await expectUnavailable(rail.getAccountInfo("PLAYER"));
    await expectUnavailable(rail.buildOptInTxn("PLAYER"));

    rail.control.restoreQueries();
    await expect(rail.getTransactionStatus("unknown")).resolves.toMatchObject({
      status: "not_found",
    });
  });

  it("ambiguous settle and submit honor applied false and true outcomes", async () => {
    const rail = createMockRail({ initialTreasury: { usdcMicroUsdc: 1_000 } });
    const unappliedPayment = payment(rail, "settle-not-applied", 100);
    const appliedPayment = payment(rail, "settle-applied", 200);
    const okPayment = payment(rail, "settle-ok", 300);
    rail.control.queueSettle(
      { ok: false, reason: "unavailable", applied: false },
      { ok: false, reason: "unavailable", applied: true },
      { ok: true },
    );

    await rail.settle(
      unappliedPayment.header,
      unappliedPayment.challenge.required,
    );
    await rail.settle(appliedPayment.header, appliedPayment.challenge.required);
    const ok = await rail.settle(
      okPayment.header,
      okPayment.challenge.required,
    );
    expect(ok).toMatchObject({ ok: true, txid: "mocktx_000002" });
    await expect(
      rail.getTransactionStatus("mockpay_settle-not-applied"),
    ).resolves.toMatchObject({
      status: "not_found",
    });
    await expect(
      rail.getTransactionStatus("mockpay_settle-applied"),
    ).resolves.toMatchObject({
      status: "confirmed",
    });

    const first = await rail.preparePayouts([
      { jobId: "not-applied", recipient: "A", amountMicroUsdc: 50 },
    ]);
    const second = await rail.preparePayouts([
      { jobId: "applied", recipient: "B", amountMicroUsdc: 70 },
    ]);
    rail.control.queueSubmitPrepared(
      { ok: false, reason: "unavailable", applied: false },
      { ok: false, reason: "unavailable", applied: true },
    );
    await rail.submitPrepared(first);
    await rail.submitPrepared(second);
    await expect(rail.findPayoutByNote("not-applied")).resolves.toBeNull();
    await expect(rail.findPayoutByNote("applied")).resolves.toMatchObject({
      txid: second.txids[0]?.txid,
    });
    await expect(rail.getBalances(rail.treasuryAddress)).resolves.toEqual({
      usdcMicroUsdc: 1_430,
      algoMicroAlgo: 10_000_000,
    });

    rail.control.queueSubmitSignedTransaction(
      { ok: false, reason: "unavailable", applied: false },
      { ok: false, reason: "unavailable", applied: true },
    );
    await rail.submitSignedTransaction("signed-not-applied");
    await rail.submitSignedTransaction("signed-applied");
    await expect(rail.submitSignedTransaction("signed-ok")).resolves.toEqual({
      ok: true,
      txid: "mocktx_000006",
    });
  });

  it("overrides shadow echo memory and reset restores clean defaults", async () => {
    const rail = createMockRail();
    const paid = payment(rail, "override", 100);
    const settled = await rail.settle(paid.header, paid.challenge.required);
    if (!settled.ok) throw new Error("expected settlement success");
    const prepared = await rail.preparePayouts([
      { jobId: "job", recipient: "WINNER", amountMicroUsdc: 10 },
    ]);
    await rail.submitPrepared(prepared);
    const funding = await rail.prepareFunding({
      player: "PLAYER",
      leg: "algo",
      amount: 5,
    });
    await rail.submitPrepared(funding);

    rail.control.setHealth(false);
    rail.control.setRound(9_000);
    rail.control.setBalances(rail.treasuryAddress, { usdcMicroUsdc: 7 });
    rail.control.setAccountInfo("PLAYER", { exists: false, rekeyed: true });
    rail.control.setTxStatus(settled.txid, { status: "pending" });
    rail.control.setNoteResult("job", null);
    rail.control.setFundingNoteResult("PLAYER", "algo", null);
    expect(await rail.health()).toBe(false);
    await expect(rail.getBalances(rail.treasuryAddress)).resolves.toMatchObject(
      {
        usdcMicroUsdc: 7,
      },
    );
    await expect(rail.getAccountInfo("PLAYER")).resolves.toMatchObject({
      exists: false,
      rekeyed: true,
      optedInUsdc: true,
    });
    await expect(rail.getTransactionStatus(settled.txid)).resolves.toEqual({
      status: "pending",
    });
    await expect(rail.getTransactionStatus("unknown")).resolves.toEqual({
      status: "not_found",
      currentRound: 9_000,
    });
    await expect(rail.findPayoutByNote("job")).resolves.toBeNull();
    await expect(rail.findFundingByNote("PLAYER", "algo")).resolves.toBeNull();

    rail.control.reset();
    expect(await rail.health()).toBe(true);
    await expect(rail.getBalances(rail.treasuryAddress)).resolves.toEqual({
      usdcMicroUsdc: 10_000_000,
      algoMicroAlgo: 10_000_000,
    });
    await expect(rail.getTransactionStatus(settled.txid)).resolves.toEqual({
      status: "not_found",
      currentRound: 1_000,
    });
    await expect(rail.findPayoutByNote("job")).resolves.toBeNull();
    const next = payment(rail, "after-reset");
    await expect(
      rail.settle(next.header, next.challenge.required),
    ).resolves.toMatchObject({
      txid: "mocktx_000001",
    });
  });
});
