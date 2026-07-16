import type { PaymentChallenge, PaymentRail } from "@onestepchess/core";
import { RailError } from "@onestepchess/core";

export type PaymentRailConformanceHarness = {
  readonly rail: PaymentRail;
  readonly buildHeader: (challenge: PaymentChallenge, nonce: string) => string;
};

export type PaymentRailConformanceRow = {
  readonly name: string;
  readonly run: (
    createHarness: () => PaymentRailConformanceHarness,
  ) => Promise<void>;
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`PaymentRail conformance: ${message}`);
}

const quote = {
  amountMicroUsdc: 1_000,
  resource: "https://osc.example/api/v1/claims/conformance/move",
} as const;

export const paymentRailConformanceRows: readonly PaymentRailConformanceRow[] =
  [
    {
      name: "same header yields the same clientTxId",
      async run(createHarness) {
        const { rail, buildHeader } = createHarness();
        const header = buildHeader(
          rail.buildPaymentChallenge(quote),
          "same-header",
        );
        const first = rail.decodePayment(header);
        const second = rail.decodePayment(header);
        assert(first.ok && second.ok, "valid fixture header did not decode");
        if (first.ok && second.ok) {
          assert(
            first.payment.clientTxId === second.payment.clientTxId,
            "clientTxId changed",
          );
        }
      },
    },
    {
      name: "batch of 17 throws CONTRACT",
      async run(createHarness) {
        const { rail } = createHarness();
        const batch = Array.from({ length: 17 }, (_, index) => ({
          jobId: `job-${index}`,
          recipient: `recipient-${index}`,
          amountMicroUsdc: 1,
        }));
        try {
          await rail.preparePayouts(batch);
          throw new Error("preparePayouts accepted 17 jobs");
        } catch (error) {
          assert(
            error instanceof RailError && error.code === "CONTRACT",
            "wrong batch error",
          );
        }
      },
    },
    {
      name: "prepare has no balance effect",
      async run(createHarness) {
        const { rail } = createHarness();
        const before = await rail.getBalances(rail.treasuryAddress);
        await rail.preparePayouts([
          { jobId: "prepare-only", recipient: "A", amountMicroUsdc: 9 },
        ]);
        const after = await rail.getBalances(rail.treasuryAddress);
        assert(
          JSON.stringify(before) === JSON.stringify(after),
          "prepare changed balances",
        );
      },
    },
    {
      name: "exact prepared-byte replay applies once",
      async run(createHarness) {
        const { rail } = createHarness();
        const before = await rail.getBalances(rail.treasuryAddress);
        const prepared = await rail.preparePayouts([
          { jobId: "replay", recipient: "A", amountMicroUsdc: 11 },
        ]);
        await rail.submitPrepared(prepared);
        await rail.submitPrepared(prepared);
        const after = await rail.getBalances(rail.treasuryAddress);
        assert(
          before.usdcMicroUsdc - after.usdcMicroUsdc === 11,
          "replay applied twice",
        );
      },
    },
    {
      name: "per-job txids are unique and jobId-aligned",
      async run(createHarness) {
        const { rail } = createHarness();
        const jobs = ["aligned-a", "aligned-b", "aligned-c"];
        const prepared = await rail.preparePayouts(
          jobs.map((jobId) => ({
            jobId,
            recipient: `recipient-${jobId}`,
            amountMicroUsdc: 1,
          })),
        );
        assert(
          prepared.txids.map((item) => item.jobId).join(",") === jobs.join(","),
          "jobId order changed",
        );
        assert(
          new Set(prepared.txids.map((item) => item.txid)).size === jobs.length,
          "duplicate txids",
        );
      },
    },
    {
      name: "decode malformed never throws",
      async run(createHarness) {
        const { rail } = createHarness();
        let decoded: ReturnType<PaymentRail["decodePayment"]>;
        try {
          decoded = rail.decodePayment("%%% malformed %%%");
        } catch {
          throw new Error("decodePayment threw for malformed input");
        }
        assert(
          !decoded.ok && decoded.reason === "malformed",
          "wrong malformed result",
        );
      },
    },
  ];
