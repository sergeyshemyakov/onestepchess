import { TESTNET_CAIP2 } from "@onestepchess/agent-kit";
import { z } from "zod";

const txidSchema = z.string().regex(/^[A-Z2-7_-]{8,128}$/);
const transactionSchema = z.object({
  txid: txidSchema,
  confirmedRound: z.number().int().positive(),
  latencyMs: z.number().int().nonnegative(),
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const testnetReleaseCandidateEvidenceSchema = z
  .object({
    check: z.literal(
      "testnet_release_candidate_completes_payments_payouts_bonus_recovery_and_reconciliation",
    ),
    network: z.literal(TESTNET_CAIP2),
    recordedAt: z.iso.datetime({ offset: true }),
    freshDatabaseSha256: sha256Schema,
    restoredDatabaseSha256: sha256Schema,
    wallets: z.object({
      pera: z.literal("passed"),
      defly: z.literal("passed"),
      lute: z.literal("passed"),
    }),
    humanPayment: transactionSchema,
    agentPayment: transactionSchema,
    payout: transactionSchema,
    starterStake: z.object({
      algo: transactionSchema,
      optIn: transactionSchema,
      usdc: transactionSchema,
    }),
    crashRecovery: z.object({
      afterSettleBeforeMoveCommit: z.literal("converged"),
      afterOutgoingPreparation: z.literal("converged"),
      afterSubmission: z.literal("converged"),
      beforeConfirmation: z.literal("converged"),
    }),
    adminPauseRecovery: z.literal("passed"),
    reconciliation: z.object({
      clean: z.literal(true),
      driftMicroUsdc: z.literal(0),
    }),
    backupRestore: z.literal("passed"),
    mockRegression: z.object({
      publicClients: z.literal("passed"),
      mixedEndspiel: z.literal("passed"),
      soak: z.literal("passed"),
      chaos: z.literal("passed"),
      web: z.literal("passed"),
    }),
    sanitizedLogsSha256: sha256Schema,
    unresolvedMoneyDefects: z.literal(0),
  })
  .strict();

export const mainnetMicroSmokeEvidenceSchema = z
  .object({
    check: z.literal(
      "human_approved_mainnet_micro_smoke_matches_testnet_contracts_and_reconciles_cleanly",
    ),
    recordedAt: z.iso.datetime({ offset: true }),
    approvalRecordedAt: z.iso.datetime({ offset: true }),
    aggregateBudgetMicroUsdc: z.number().int().positive().max(100_000),
    supportedNetwork: z.literal("passed"),
    payment: transactionSchema,
    payout: transactionSchema,
    payoutNoteLookup: z.literal("passed"),
    reconciliation: z.object({
      clean: z.literal(true),
      driftMicroUsdc: z.literal(0),
    }),
    excludedActions: z.object({
      bonus: z.literal(true),
      fleet: z.literal(true),
      publicTraffic: z.literal(true),
    }),
    sanitizedLogsSha256: sha256Schema,
  })
  .strict();

export function assertEvidenceIsSecretFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (
    /mnemonic|private.?key|jwt|payment[-_ ]?signature|payloadb64|signedtxn/i.test(
      serialized,
    )
  ) {
    throw new Error("Release 4 evidence contains a forbidden secret field");
  }
}
