import type {
  PaymentRail,
  PayoutInstruction,
  PreparedSubmission,
} from "@onestepchess/core";
import { and, eq, ne } from "drizzle-orm";
import type { ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";
import { appendLedgerEntry } from "../db/ledger.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { newId } from "../ids.js";
import type { Logger } from "../logger.js";

export type PayoutExecutorDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly config: () => ServerConfig;
  readonly now: () => number;
  readonly logger: Logger;
  readonly metrics?: {
    recordFacilitatorError(): void;
    recordPayoutSubmitted(count?: number): void;
    recordPayoutConfirmed(count?: number): void;
    recordPayoutFailed(count?: number): void;
  };
  readonly alerts?: {
    emit(type: string, payload?: Record<string, unknown>): Promise<boolean>;
  };
};

const POLL_MS = 1_000;
const BACKOFF_BASE_MS = 1_000;

export function registerPayoutCommands(deps: PayoutExecutorDeps): void {
  const { db } = deps;

  // Persist the treasury-signed bytes + per-job txids BEFORE any broadcast, so
  // a crash after preparation can only ever resubmit the exact same payload.
  deps.coordinator.register(
    "PayoutPrepared",
    (
      ctx,
      payload: {
        batchId: string;
        payloadB64: string;
        groupId: string;
        lastValidRound: number;
        jobTxids: readonly { jobId: string; txid: string }[];
      },
    ) => {
      db.insert(schema.payoutBatches)
        .values({
          id: payload.batchId,
          status: "prepared",
          payloadB64: payload.payloadB64,
          groupId: payload.groupId,
          lastValidRound: payload.lastValidRound,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run();
      for (const { jobId, txid } of payload.jobTxids) {
        db.update(schema.payoutJobs)
          .set({ status: "prepared", batchId: payload.batchId, txid })
          .where(
            and(
              eq(schema.payoutJobs.id, jobId),
              eq(schema.payoutJobs.status, "pending"),
            ),
          )
          .run();
      }
    },
  );

  deps.coordinator.register(
    "PayoutSubmitted",
    (ctx, payload: { batchId: string }) => {
      db.update(schema.payoutBatches)
        .set({ status: "submitted", updatedAt: ctx.now })
        .where(
          and(
            eq(schema.payoutBatches.id, payload.batchId),
            eq(schema.payoutBatches.status, "prepared"),
          ),
        )
        .run();
      const submitted = db
        .update(schema.payoutJobs)
        .set({ status: "submitted" })
        .where(
          and(
            eq(schema.payoutJobs.batchId, payload.batchId),
            eq(schema.payoutJobs.status, "prepared"),
          ),
        )
        .run().changes;
      if (submitted > 0) {
        ctx.afterCommit(() => deps.metrics?.recordPayoutSubmitted(submitted));
      }
    },
  );

  deps.coordinator.register(
    "PayoutConfirmed",
    (ctx, payload: { jobId: string; txid: string }) => {
      const job = db
        .select()
        .from(schema.payoutJobs)
        .where(eq(schema.payoutJobs.id, payload.jobId))
        .get();
      // Idempotent: a duplicate confirmation (crash replay, note+status race)
      // must not write a second −amount ledger row.
      if (job === undefined || job.status === "confirmed") return;
      db.update(schema.payoutJobs)
        .set({ status: "confirmed", txid: payload.txid })
        .where(eq(schema.payoutJobs.id, job.id))
        .run();
      appendLedgerEntry(db, {
        ts: ctx.now,
        account: "treasury",
        deltaMicrousdc: -job.amount,
        refType: "payout",
        refId: job.id,
        txid: payload.txid,
      });
      ctx.appendEvent("payout_confirmed", job.recipient, {
        gameId: job.gameId,
        txid: payload.txid,
        amountMicroUsdc: job.amount,
      });
      if (job.batchId !== null) {
        const outstanding = db
          .select({ id: schema.payoutJobs.id })
          .from(schema.payoutJobs)
          .where(
            and(
              eq(schema.payoutJobs.batchId, job.batchId),
              ne(schema.payoutJobs.status, "confirmed"),
            ),
          )
          .get();
        if (outstanding === undefined) {
          db.update(schema.payoutBatches)
            .set({ status: "confirmed", updatedAt: ctx.now })
            .where(eq(schema.payoutBatches.id, job.batchId))
            .run();
        }
      }
      ctx.afterCommit(() => deps.metrics?.recordPayoutConfirmed());
    },
  );

  // A definitely-rejected or expired batch: its jobs retry with exponential
  // backoff and re-prepare fresh bytes; exhausted attempts become 'failed'
  // (a visible terminal state — admin re-arm is Release 3).
  deps.coordinator.register(
    "PayoutBatchDiscarded",
    (ctx, payload: { batchId: string }) => {
      const max = deps.config().PAYOUT_MAX_ATTEMPTS;
      const jobs = db
        .select()
        .from(schema.payoutJobs)
        .where(
          and(
            eq(schema.payoutJobs.batchId, payload.batchId),
            ne(schema.payoutJobs.status, "confirmed"),
          ),
        )
        .all();
      let failed = 0;
      for (const job of jobs) {
        const attempts = job.attempts + 1;
        if (attempts >= max) {
          db.update(schema.payoutJobs)
            .set({ status: "failed", attempts, batchId: null, txid: null })
            .where(eq(schema.payoutJobs.id, job.id))
            .run();
          failed += 1;
        } else {
          db.update(schema.payoutJobs)
            .set({
              status: "pending",
              attempts,
              batchId: null,
              txid: null,
              nextAttemptAt: ctx.now + BACKOFF_BASE_MS * 2 ** (attempts - 1),
            })
            .where(eq(schema.payoutJobs.id, job.id))
            .run();
        }
      }
      db.update(schema.payoutBatches)
        .set({ status: "failed", updatedAt: ctx.now })
        .where(eq(schema.payoutBatches.id, payload.batchId))
        .run();
      if (failed > 0) {
        ctx.afterCommit(() => {
          deps.metrics?.recordPayoutFailed(failed);
          void deps.alerts?.emit("payout_exhausted", {
            batchId: payload.batchId,
            failed,
          });
        });
      }
    },
  );
}

/** One executor pass, outside the coordinator queue (F7 steps 3–4, F1 step 6).
 * Returns the next epoch-ms at which work is due, or null when idle. Callers
 * schedule the next tick; the pass itself is idempotent and crash-safe. */
export async function runPayoutExecutor(
  deps: PayoutExecutorDeps,
): Promise<number | null> {
  const now = deps.now();
  const cfg = deps.config();
  const boundaryMs = cfg.PAYMENT_RECOVERY_TIMEOUT_SECONDS * 1_000;
  let nextDue: number | null = null;
  const schedule = (at: number): void => {
    nextDue = nextDue === null ? at : Math.min(nextDue, at);
  };

  // Phase 1 — prepare due pending jobs, chunked ≤ PAYOUT_BATCH_MAX so the rail's
  // hard 17-cap is never reached. Preparation signs but never broadcasts.
  const pending = deps.db
    .select()
    .from(schema.payoutJobs)
    .where(eq(schema.payoutJobs.status, "pending"))
    .all();
  const due = pending.filter(
    (job) => job.nextAttemptAt === null || job.nextAttemptAt <= now,
  );
  for (const job of pending) {
    if (job.nextAttemptAt !== null && job.nextAttemptAt > now)
      schedule(job.nextAttemptAt);
  }
  for (let i = 0; i < due.length; i += cfg.PAYOUT_BATCH_MAX) {
    const chunk = due.slice(i, i + cfg.PAYOUT_BATCH_MAX);
    const instructions: PayoutInstruction[] = chunk.map((job) => ({
      jobId: job.id,
      recipient: job.recipient,
      amountMicroUsdc: job.amount,
    }));
    try {
      const prepared = await deps.rail.preparePayouts(instructions);
      await deps.coordinator.dispatch({
        type: "PayoutPrepared",
        payload: {
          batchId: newId("pb_"),
          payloadB64: prepared.payloadB64,
          groupId: prepared.groupId,
          lastValidRound: prepared.lastValidRound,
          jobTxids: prepared.txids,
        },
        refIds: chunk.map((job) => job.id),
      });
    } catch (error) {
      deps.metrics?.recordFacilitatorError();
      deps.logger.error({ err: error }, "payout preparation failed");
      schedule(now + POLL_MS);
    }
  }

  // Phase 2 — broadcast prepared batches using their exact persisted bytes.
  const preparedBatches = deps.db
    .select()
    .from(schema.payoutBatches)
    .where(eq(schema.payoutBatches.status, "prepared"))
    .all();
  for (const batch of preparedBatches) {
    const jobs = deps.db
      .select()
      .from(schema.payoutJobs)
      .where(eq(schema.payoutJobs.batchId, batch.id))
      .all();
    if (jobs.length === 0) continue;
    const submission: PreparedSubmission = {
      kind: "payouts",
      payloadB64: batch.payloadB64,
      groupId: batch.groupId,
      txids: jobs.map((job) => ({ jobId: job.id, txid: job.txid ?? "" })),
      lastValidRound: batch.lastValidRound,
    };
    let result: Awaited<ReturnType<PaymentRail["submitPrepared"]>>;
    try {
      result = await deps.rail.submitPrepared(submission);
    } catch (error) {
      deps.metrics?.recordFacilitatorError();
      deps.logger.error({ err: error, batch: batch.id }, "payout submit threw");
      await deps.coordinator.dispatch({
        type: "PayoutSubmitted",
        payload: { batchId: batch.id },
        refIds: [batch.id],
      });
      schedule(now + POLL_MS);
      continue;
    }
    if (result.ok) {
      await deps.coordinator.dispatch({
        type: "PayoutSubmitted",
        payload: { batchId: batch.id },
        refIds: [batch.id],
      });
    } else if (result.reason === "rejected") {
      deps.metrics?.recordFacilitatorError();
      await deps.coordinator.dispatch({
        type: "PayoutBatchDiscarded",
        payload: { batchId: batch.id },
        refIds: [batch.id],
      });
      schedule(now + POLL_MS);
    } else {
      deps.metrics?.recordFacilitatorError();
      // Ambiguous: the exact bytes may already be on chain. Treat them as
      // submitted so recovery queries the durable txids and reconciliation
      // includes the possible outbound transfer.
      await deps.coordinator.dispatch({
        type: "PayoutSubmitted",
        payload: { batchId: batch.id },
        refIds: [batch.id],
      });
      schedule(now + POLL_MS);
    }
  }

  // Phase 3 — confirm submitted batches; findPayoutByNote is the secondary
  // guard when the status query cannot resolve a txid.
  const submittedBatches = deps.db
    .select()
    .from(schema.payoutBatches)
    .where(eq(schema.payoutBatches.status, "submitted"))
    .all();
  for (const batch of submittedBatches) {
    const jobs = deps.db
      .select()
      .from(schema.payoutJobs)
      .where(
        and(
          eq(schema.payoutJobs.batchId, batch.id),
          ne(schema.payoutJobs.status, "confirmed"),
        ),
      )
      .all();
    let missingStale = false;
    let stillPending = false;
    for (const job of jobs) {
      if (job.txid === null) {
        stillPending = true;
        continue;
      }
      let confirmed: { txid: string } | null = null;
      try {
        const status = await deps.rail.getTransactionStatus(job.txid);
        if (status.status === "confirmed") {
          confirmed = { txid: job.txid };
        } else if (status.status === "not_found") {
          const expired =
            cfg.CAIP2 === "mock:local"
              ? now >= batch.updatedAt + boundaryMs
              : status.currentRound > batch.lastValidRound;
          if (expired) missingStale = true;
          else stillPending = true;
        } else {
          stillPending = true;
        }
      } catch (error) {
        deps.metrics?.recordFacilitatorError();
        deps.logger.warn(
          { err: error, job: job.id },
          "payout status query unavailable",
        );
        stillPending = true;
      }
      if (confirmed === null) {
        try {
          const note = await deps.rail.findPayoutByNote(job.id);
          if (note !== null) confirmed = { txid: note.txid };
        } catch {
          deps.metrics?.recordFacilitatorError();
          stillPending = true;
        }
      }
      if (confirmed !== null) {
        await deps.coordinator.dispatch({
          type: "PayoutConfirmed",
          payload: { jobId: job.id, txid: confirmed.txid },
          refIds: [job.id],
        });
      } else {
        schedule(now + POLL_MS);
      }
    }
    const confirmed = deps.db
      .select({ id: schema.payoutJobs.id })
      .from(schema.payoutJobs)
      .where(
        and(
          eq(schema.payoutJobs.batchId, batch.id),
          eq(schema.payoutJobs.status, "confirmed"),
        ),
      )
      .get();
    // Nothing landed and validity has expired: discard for a fresh preparation.
    if (missingStale && !stillPending && confirmed === undefined) {
      await deps.coordinator.dispatch({
        type: "PayoutBatchDiscarded",
        payload: { batchId: batch.id },
        refIds: [batch.id],
      });
      schedule(now + POLL_MS);
    }
  }

  return nextDue;
}
