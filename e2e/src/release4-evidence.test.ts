import { TESTNET_CAIP2 } from "@onestepchess/agent-kit";
import { describe, expect, it } from "vitest";
import {
  assertEvidenceIsSecretFree,
  mainnetMicroSmokeEvidenceSchema,
  testnetReleaseCandidateEvidenceSchema,
} from "./release4-evidence.js";

const at = "2026-07-31T18:00:00.000Z";
const sha = "a".repeat(64);
const transaction = {
  txid: "RELEASE4_TXID_ABCDEFGH",
  confirmedRound: 20_001,
  latencyMs: 1_250,
};

describe("Release 4 promotion evidence", () => {
  it("release4_evidence_contract_requires_every_testnet_application_and_mainnet_micro_smoke_fact", () => {
    const testnet = {
      check:
        "testnet_release_candidate_completes_payments_payouts_bonus_recovery_and_reconciliation",
      network: TESTNET_CAIP2,
      recordedAt: at,
      freshDatabaseSha256: sha,
      restoredDatabaseSha256: sha,
      wallets: { pera: "passed", defly: "passed", lute: "passed" },
      humanPayment: transaction,
      agentPayment: transaction,
      payout: transaction,
      starterStake: {
        algo: transaction,
        optIn: transaction,
        usdc: transaction,
      },
      crashRecovery: {
        afterSettleBeforeMoveCommit: "converged",
        afterOutgoingPreparation: "converged",
        afterSubmission: "converged",
        beforeConfirmation: "converged",
      },
      adminPauseRecovery: "passed",
      reconciliation: { clean: true, driftMicroUsdc: 0 },
      backupRestore: "passed",
      mockRegression: {
        publicClients: "passed",
        mixedEndspiel: "passed",
        soak: "passed",
        chaos: "passed",
        web: "passed",
      },
      sanitizedLogsSha256: sha,
      unresolvedMoneyDefects: 0,
    };
    expect(testnetReleaseCandidateEvidenceSchema.parse(testnet)).toBeDefined();
    const { starterStake: _omitted, ...incomplete } = testnet;
    expect(
      testnetReleaseCandidateEvidenceSchema.safeParse(incomplete).success,
    ).toBe(false);

    const mainnet = {
      check:
        "human_approved_mainnet_micro_smoke_matches_testnet_contracts_and_reconciles_cleanly",
      recordedAt: at,
      approvalRecordedAt: at,
      aggregateBudgetMicroUsdc: 100_000,
      supportedNetwork: "passed",
      payment: transaction,
      payout: transaction,
      payoutNoteLookup: "passed",
      reconciliation: { clean: true, driftMicroUsdc: 0 },
      excludedActions: { bonus: true, fleet: true, publicTraffic: true },
      sanitizedLogsSha256: sha,
    };
    expect(mainnetMicroSmokeEvidenceSchema.parse(mainnet)).toBeDefined();
    expect(
      mainnetMicroSmokeEvidenceSchema.safeParse({
        ...mainnet,
        aggregateBudgetMicroUsdc: 100_001,
      }).success,
    ).toBe(false);
    expect(() =>
      assertEvidenceIsSecretFree({ ...mainnet, signedTxnB64: "forbidden" }),
    ).toThrow(/forbidden secret field/);
  });
});
