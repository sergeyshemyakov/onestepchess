import type { PaymentRail, PreparedFunding } from "@onestepchess/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AdminReadCache } from "../admin/cache.js";
import { currentMode } from "../boot.js";
import type { ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";
import { appendLedgerEntry } from "../db/ledger.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { newId } from "../ids.js";
import type { Logger } from "../logger.js";
import { BONUS_SKIP_ALGO_MICRO } from "./lifecycle.js";

const POLL_MS = 1_000;
const BACKOFF_BASE_MS = 1_000;
const ALGO_FUNDING_FEE_MICRO = 1_000;

export function hasAlgoFundingCapacity(
  bonusAlgoMicro: number,
  amountMicro: number,
  floorMicro: number,
): boolean {
  return bonusAlgoMicro - amountMicro - ALGO_FUNDING_FEE_MICRO >= floorMicro;
}

export type FundingExecutorDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly config: () => ServerConfig;
  readonly now: () => number;
  readonly logger: Logger;
  readonly alerts?: {
    emit(type: string, payload?: Record<string, unknown>): Promise<boolean>;
  };
  readonly cache?: AdminReadCache;
};

function invalidate(deps: FundingExecutorDeps): void {
  deps.cache?.invalidate("bonuses", "overview", "activity", "players");
}

export function registerFundingCommands(deps: FundingExecutorDeps): void {
  deps.coordinator.register(
    "FundingJobCreated",
    (
      ctx,
      payload: {
        readonly player: string;
        readonly leg: "algo" | "usdc";
        readonly amount: number;
      },
    ) => {
      const bonus = deps.db
        .select()
        .from(schema.bonuses)
        .where(eq(schema.bonuses.player, payload.player))
        .get();
      const expectedStatus = payload.leg === "algo" ? "claimed" : "opted_in";
      if (bonus === undefined || bonus.status !== expectedStatus) {
        return { created: false as const };
      }
      const existing = deps.db
        .select({ id: schema.fundingJobs.id })
        .from(schema.fundingJobs)
        .where(
          and(
            eq(schema.fundingJobs.player, payload.player),
            eq(schema.fundingJobs.leg, payload.leg),
          ),
        )
        .get();
      if (existing !== undefined) return { created: false as const };
      const id = newId("fj_");
      deps.db
        .insert(schema.fundingJobs)
        .values({
          id,
          player: payload.player,
          leg: payload.leg,
          amount: payload.amount,
          status: "pending",
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run();
      ctx.afterCommit(() => invalidate(deps));
      return { created: true as const, id };
    },
  );

  deps.coordinator.register(
    "FundingPendingAlgoSkipped",
    (ctx, payload: { readonly player: string }) => {
      const changes = deps.db
        .delete(schema.fundingJobs)
        .where(
          and(
            eq(schema.fundingJobs.player, payload.player),
            eq(schema.fundingJobs.leg, "algo"),
            eq(schema.fundingJobs.status, "pending"),
          ),
        )
        .run().changes;
      if (changes > 0) ctx.afterCommit(() => invalidate(deps));
      return { changed: changes > 0 };
    },
  );

  deps.coordinator.register(
    "FundingPrepared",
    (
      ctx,
      payload: {
        readonly jobId: string;
        readonly payloadB64: string;
        readonly txid: string;
        readonly lastValidRound: number;
      },
    ) => {
      const changes = deps.db
        .update(schema.fundingJobs)
        .set({
          status: "prepared",
          payloadB64: payload.payloadB64,
          txid: payload.txid,
          lastValidRound: payload.lastValidRound,
          updatedAt: ctx.now,
        })
        .where(
          and(
            eq(schema.fundingJobs.id, payload.jobId),
            eq(schema.fundingJobs.status, "pending"),
          ),
        )
        .run().changes;
      if (changes > 0) ctx.afterCommit(() => invalidate(deps));
      return { changed: changes > 0 };
    },
  );

  deps.coordinator.register(
    "FundingSubmitted",
    (ctx, payload: { readonly jobId: string }) => {
      const changes = deps.db
        .update(schema.fundingJobs)
        .set({ status: "submitted", updatedAt: ctx.now })
        .where(
          and(
            eq(schema.fundingJobs.id, payload.jobId),
            eq(schema.fundingJobs.status, "prepared"),
          ),
        )
        .run().changes;
      if (changes > 0) ctx.afterCommit(() => invalidate(deps));
      return { changed: changes > 0 };
    },
  );

  deps.coordinator.register(
    "FundingConfirmed",
    (ctx, payload: { readonly jobId: string; readonly txid: string }) => {
      const job = deps.db
        .select()
        .from(schema.fundingJobs)
        .where(eq(schema.fundingJobs.id, payload.jobId))
        .get();
      if (job === undefined || job.status === "confirmed") {
        return { changed: false as const };
      }
      const bonus = deps.db
        .select()
        .from(schema.bonuses)
        .where(eq(schema.bonuses.player, job.player))
        .get();
      if (bonus === undefined) return { changed: false as const };
      deps.db
        .update(schema.fundingJobs)
        .set({ status: "confirmed", txid: payload.txid, updatedAt: ctx.now })
        .where(eq(schema.fundingJobs.id, job.id))
        .run();
      if (job.leg === "algo") {
        deps.db
          .update(schema.bonuses)
          .set({ algoTxid: payload.txid })
          .where(eq(schema.bonuses.player, job.player))
          .run();
      } else if (bonus.status !== "funded") {
        deps.db
          .update(schema.bonuses)
          .set({
            status: "funded",
            usdcTxid: payload.txid,
            fundedAt: ctx.now,
          })
          .where(eq(schema.bonuses.player, job.player))
          .run();
        const ledgerExists =
          deps.db
            .select({ id: schema.ledger.id })
            .from(schema.ledger)
            .where(
              and(
                eq(schema.ledger.refType, "bonus"),
                eq(schema.ledger.refId, job.id),
              ),
            )
            .get() !== undefined;
        if (!ledgerExists) {
          appendLedgerEntry(deps.db, {
            ts: ctx.now,
            account: "bonus",
            deltaMicrousdc: -job.amount,
            refType: "bonus",
            refId: job.id,
            txid: payload.txid,
          });
        }
        ctx.appendEvent("bonus_updated", job.player, { status: "funded" });
      }
      ctx.afterCommit(() => invalidate(deps));
      return { changed: true as const };
    },
  );

  deps.coordinator.register(
    "FundingDiscarded",
    (
      ctx,
      payload: { readonly jobId: string; readonly safeToReset: boolean },
    ) => {
      const job = deps.db
        .select()
        .from(schema.fundingJobs)
        .where(eq(schema.fundingJobs.id, payload.jobId))
        .get();
      if (job === undefined || job.status === "confirmed") {
        return { status: "ignored" as const };
      }
      const attempts = job.attempts + 1;
      const exhausted = attempts >= deps.config().BONUS_MAX_ATTEMPTS;
      deps.db
        .update(schema.fundingJobs)
        .set({
          status: exhausted ? "failed" : "pending",
          attempts,
          nextAttemptAt: exhausted
            ? null
            : ctx.now + BACKOFF_BASE_MS * 2 ** (attempts - 1),
          updatedAt: ctx.now,
          ...(!exhausted && payload.safeToReset
            ? { payloadB64: null, txid: null, lastValidRound: null }
            : {}),
        })
        .where(eq(schema.fundingJobs.id, job.id))
        .run();
      if (exhausted) {
        ctx.afterCommit(() => {
          void deps.alerts?.emit("bonus_funding_exhausted", {
            player: job.player,
            leg: job.leg,
          });
        });
      }
      ctx.afterCommit(() => invalidate(deps));
      return { status: exhausted ? ("failed" as const) : ("pending" as const) };
    },
  );

  deps.coordinator.register(
    "AdminBonusRetry",
    (
      ctx,
      payload: {
        readonly actor: string;
        readonly player: string;
        readonly jobIds: readonly string[];
      },
    ) => {
      let changed = 0;
      for (const jobId of payload.jobIds) {
        changed += deps.db
          .update(schema.fundingJobs)
          .set({
            status: "pending",
            attempts: 0,
            nextAttemptAt: null,
            payloadB64: null,
            txid: null,
            lastValidRound: null,
            updatedAt: ctx.now,
          })
          .where(
            and(
              eq(schema.fundingJobs.id, jobId),
              eq(schema.fundingJobs.player, payload.player),
              eq(schema.fundingJobs.status, "failed"),
            ),
          )
          .run().changes;
      }
      if (changed === 0) return { status: "not_failed" as const };
      deps.db
        .insert(schema.auditLog)
        .values({
          ts: ctx.now,
          actor: payload.actor,
          action: "bonus.retry",
          payloadJson: JSON.stringify({
            player: payload.player,
            jobs: payload.jobIds,
          }),
        })
        .run();
      ctx.afterCommit(() => invalidate(deps));
      return { status: "pending" as const, jobs: changed };
    },
  );
}

async function ensureFundingJobs(deps: FundingExecutorDeps): Promise<void> {
  const bonuses = deps.db
    .select()
    .from(schema.bonuses)
    .where(inArray(schema.bonuses.status, ["claimed", "opted_in"]))
    .all();
  for (const bonus of bonuses) {
    if (bonus.status === "opted_in") {
      await deps.coordinator.dispatch({
        type: "FundingJobCreated",
        payload: {
          player: bonus.player,
          leg: "usdc",
          amount: bonus.usdcAmount,
        },
        refIds: [bonus.player],
      });
      continue;
    }
    let account: Awaited<ReturnType<PaymentRail["getAccountInfo"]>>;
    try {
      account = await deps.rail.getAccountInfo(bonus.player);
    } catch (error) {
      deps.logger.warn(
        { err: error, player: bonus.player },
        "starter-stake account query unavailable",
      );
      continue;
    }
    if (account.optedInUsdc) {
      await deps.coordinator.dispatch({
        type: "FundingPendingAlgoSkipped",
        payload: { player: bonus.player },
        refIds: [bonus.player],
      });
      await deps.coordinator.dispatch({
        type: "BonusOptInObserved",
        payload: { player: bonus.player },
        refIds: [bonus.player],
      });
      await deps.coordinator.dispatch({
        type: "FundingJobCreated",
        payload: {
          player: bonus.player,
          leg: "usdc",
          amount: bonus.usdcAmount,
        },
        refIds: [bonus.player],
      });
      continue;
    }
    let balances: Awaited<ReturnType<PaymentRail["getBalances"]>>;
    try {
      balances = await deps.rail.getBalances(bonus.player);
    } catch (error) {
      deps.logger.warn(
        { err: error, player: bonus.player },
        "starter-stake balance query unavailable",
      );
      continue;
    }
    if (balances.algoMicroAlgo >= BONUS_SKIP_ALGO_MICRO) {
      await deps.coordinator.dispatch({
        type: "FundingPendingAlgoSkipped",
        payload: { player: bonus.player },
        refIds: [bonus.player],
      });
      continue;
    }
    await deps.coordinator.dispatch({
      type: "FundingJobCreated",
      payload: {
        player: bonus.player,
        leg: "algo",
        amount: bonus.algoAmount,
      },
      refIds: [bonus.player],
    });
  }
}

async function sendGuard(
  deps: FundingExecutorDeps,
  job: typeof schema.fundingJobs.$inferSelect,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
  if (currentMode(deps.db) === "paused") {
    return { ok: false, reason: "paused" };
  }
  let balances: Awaited<ReturnType<PaymentRail["getBalances"]>>;
  try {
    balances = await deps.rail.getBalances(deps.rail.bonusAddress);
  } catch {
    return { ok: false, reason: "balance_dependency" };
  }
  if (
    job.leg === "algo" &&
    !hasAlgoFundingCapacity(
      balances.algoMicroAlgo,
      job.amount,
      deps.config().BONUS_MIN_ALGO_MICRO,
    )
  ) {
    return { ok: false, reason: "algo_floor" };
  }
  if (job.leg === "usdc" && balances.usdcMicroUsdc < job.amount) {
    return { ok: false, reason: "usdc_balance" };
  }
  return { ok: true };
}

function asPrepared(
  job: typeof schema.fundingJobs.$inferSelect,
): PreparedFunding | null {
  if (
    job.payloadB64 === null ||
    job.txid === null ||
    job.lastValidRound === null
  ) {
    return null;
  }
  return {
    kind: "funding",
    payloadB64: job.payloadB64,
    player: job.player,
    leg: job.leg,
    txid: job.txid,
    lastValidRound: job.lastValidRound,
  };
}

function expiredNotFound(
  deps: FundingExecutorDeps,
  job: typeof schema.fundingJobs.$inferSelect,
  currentRound: number,
): boolean {
  if (job.lastValidRound === null) return false;
  if (deps.config().CAIP2 !== "mock:local") {
    return currentRound > job.lastValidRound;
  }
  return (
    deps.now() >=
    job.updatedAt + deps.config().PAYMENT_RECOVERY_TIMEOUT_SECONDS * 1_000
  );
}

async function recoverSubmitted(
  deps: FundingExecutorDeps,
  schedule: (at: number) => void,
): Promise<void> {
  const jobs = deps.db
    .select()
    .from(schema.fundingJobs)
    .where(eq(schema.fundingJobs.status, "submitted"))
    .all();
  for (const job of jobs) {
    if (job.txid === null) {
      schedule(deps.now() + POLL_MS);
      continue;
    }
    let confirmedTxid: string | null = null;
    let expired = false;
    let statusAvailable = false;
    try {
      const status = await deps.rail.getTransactionStatus(job.txid);
      statusAvailable = true;
      if (status.status === "confirmed") confirmedTxid = job.txid;
      else if (status.status === "not_found")
        expired = expiredNotFound(deps, job, status.currentRound);
    } catch (error) {
      deps.logger.warn(
        { err: error, job: job.id },
        "funding status unavailable",
      );
    }
    let noteAvailable = false;
    if (confirmedTxid === null) {
      try {
        const note = await deps.rail.findFundingByNote(job.player, job.leg);
        noteAvailable = true;
        if (note !== null) confirmedTxid = note.txid;
      } catch (error) {
        deps.logger.warn(
          { err: error, job: job.id },
          "funding note query unavailable",
        );
      }
    }
    if (confirmedTxid !== null) {
      await deps.coordinator.dispatch({
        type: "FundingConfirmed",
        payload: { jobId: job.id, txid: confirmedTxid },
        refIds: [job.id],
      });
    } else if (expired && statusAvailable && noteAvailable) {
      await deps.coordinator.dispatch({
        type: "FundingDiscarded",
        payload: { jobId: job.id, safeToReset: true },
        refIds: [job.id],
      });
    } else {
      schedule(deps.now() + POLL_MS);
    }
  }
}

async function submitPrepared(
  deps: FundingExecutorDeps,
  schedule: (at: number) => void,
  alreadyAttempted: Set<string>,
): Promise<void> {
  const jobs = deps.db
    .select()
    .from(schema.fundingJobs)
    .where(eq(schema.fundingJobs.status, "prepared"))
    .all();
  for (const job of jobs) {
    if (alreadyAttempted.has(job.id)) continue;
    alreadyAttempted.add(job.id);
    const guard = await sendGuard(deps, job);
    if (!guard.ok) {
      void deps.alerts?.emit("bonus_funding_deferred", {
        player: job.player,
        leg: job.leg,
        reason: guard.reason,
      });
      schedule(deps.now() + POLL_MS);
      continue;
    }
    const prepared = asPrepared(job);
    if (prepared === null)
      throw new Error(`prepared funding job ${job.id} lacks bytes`);
    let result: Awaited<ReturnType<PaymentRail["submitPrepared"]>>;
    try {
      result = await deps.rail.submitPrepared(prepared);
    } catch (error) {
      deps.logger.warn(
        { err: error, job: job.id },
        "funding submit unavailable",
      );
      await deps.coordinator.dispatch({
        type: "FundingSubmitted",
        payload: { jobId: job.id },
        refIds: [job.id],
      });
      schedule(deps.now() + POLL_MS);
      continue;
    }
    if (result.ok) {
      await deps.coordinator.dispatch({
        type: "FundingSubmitted",
        payload: { jobId: job.id },
        refIds: [job.id],
      });
    } else if (result.reason === "rejected") {
      // A rejection can be a duplicate POST of bytes that already landed via
      // a crash-resubmit (same failure as the 2026-08-22 payout incident), so
      // clearing the durable bytes is safe only when the txid is provably
      // absent from the chain. Anything visible — or unknowable — is treated
      // as submitted and left to recovery's chain-verified confirm/expire.
      let bytesProvablyAbsent = false;
      if (job.txid !== null) {
        try {
          const status = await deps.rail.getTransactionStatus(job.txid);
          bytesProvablyAbsent = status.status === "not_found";
        } catch (error) {
          deps.logger.warn(
            { err: error, job: job.id },
            "funding rejection triage unavailable",
          );
        }
      }
      await deps.coordinator.dispatch({
        type: bytesProvablyAbsent ? "FundingDiscarded" : "FundingSubmitted",
        payload: bytesProvablyAbsent
          ? { jobId: job.id, safeToReset: true }
          : { jobId: job.id },
        refIds: [job.id],
      });
      if (!bytesProvablyAbsent) schedule(deps.now() + POLL_MS);
    } else {
      await deps.coordinator.dispatch({
        type: "FundingSubmitted",
        payload: { jobId: job.id },
        refIds: [job.id],
      });
      schedule(deps.now() + POLL_MS);
    }
  }
}

/** One crash-safe pass. Existing submitted/prepared work is recovered before
 * account observations can create and submit a fresh discretionary leg. */
export async function runFundingExecutor(
  deps: FundingExecutorDeps,
): Promise<number | null> {
  let nextDue: number | null = null;
  const schedule = (at: number): void => {
    nextDue = nextDue === null ? at : Math.min(nextDue, at);
  };
  const attempted = new Set<string>();

  await recoverSubmitted(deps, schedule);
  await submitPrepared(deps, schedule, attempted);
  await recoverSubmitted(deps, schedule);
  await ensureFundingJobs(deps);

  const now = deps.now();
  const pending = deps.db
    .select()
    .from(schema.fundingJobs)
    .where(eq(schema.fundingJobs.status, "pending"))
    .all();
  for (const job of pending) {
    if (job.nextAttemptAt !== null && job.nextAttemptAt > now) {
      schedule(job.nextAttemptAt);
      continue;
    }
    const guard = await sendGuard(deps, job);
    if (!guard.ok) {
      void deps.alerts?.emit("bonus_funding_deferred", {
        player: job.player,
        leg: job.leg,
        reason: guard.reason,
      });
      schedule(now + POLL_MS);
      continue;
    }
    try {
      const prepared = await deps.rail.prepareFunding({
        player: job.player,
        leg: job.leg,
        amount: job.amount,
      });
      await deps.coordinator.dispatch({
        type: "FundingPrepared",
        payload: {
          jobId: job.id,
          payloadB64: prepared.payloadB64,
          txid: prepared.txid,
          lastValidRound: prepared.lastValidRound,
        },
        refIds: [job.id],
      });
    } catch (error) {
      deps.logger.warn(
        { err: error, job: job.id },
        "funding preparation unavailable",
      );
      schedule(now + POLL_MS);
    }
  }

  await submitPrepared(deps, schedule, attempted);
  await recoverSubmitted(deps, schedule);
  return nextDue;
}

export async function rearmBonusFunding(
  deps: FundingExecutorDeps,
  player: string,
  actor: string,
): Promise<
  | { readonly status: "not_found" | "not_failed" | "unsafe" }
  | { readonly status: "pending"; readonly jobs: number }
> {
  const bonus = deps.db
    .select({ player: schema.bonuses.player })
    .from(schema.bonuses)
    .where(eq(schema.bonuses.player, player))
    .get();
  if (bonus === undefined) return { status: "not_found" };
  const failed = deps.db
    .select()
    .from(schema.fundingJobs)
    .where(
      and(
        eq(schema.fundingJobs.player, player),
        eq(schema.fundingJobs.status, "failed"),
      ),
    )
    .all();
  if (failed.length === 0) return { status: "not_failed" };

  const safe: string[] = [];
  for (const job of failed) {
    if (job.txid === null || job.payloadB64 === null) {
      safe.push(job.id);
      continue;
    }
    try {
      const status = await deps.rail.getTransactionStatus(job.txid);
      if (status.status === "confirmed") {
        await deps.coordinator.dispatch({
          type: "FundingConfirmed",
          payload: { jobId: job.id, txid: job.txid },
          refIds: [job.id],
        });
        continue;
      }
      const note = await deps.rail.findFundingByNote(job.player, job.leg);
      if (note !== null) {
        await deps.coordinator.dispatch({
          type: "FundingConfirmed",
          payload: { jobId: job.id, txid: note.txid },
          refIds: [job.id],
        });
        continue;
      }
      if (
        status.status !== "not_found" ||
        !expiredNotFound(deps, job, status.currentRound)
      ) {
        return { status: "unsafe" };
      }
      safe.push(job.id);
    } catch {
      return { status: "unsafe" };
    }
  }
  if (safe.length === 0) return { status: "not_failed" };
  const result = await deps.coordinator.dispatch<
    { actor: string; player: string; jobIds: readonly string[] },
    { status: "not_failed" } | { status: "pending"; jobs: number }
  >({
    type: "AdminBonusRetry",
    payload: { actor, player, jobIds: safe },
    refIds: [player, ...safe],
  });
  if (result.kind !== "ok") throw new Error("bonus retry deprioritized");
  return result.result;
}

export function fundingGroundTruth(db: Db): {
  readonly pending: number;
  readonly prepared: number;
  readonly submitted: number;
  readonly failed: number;
} {
  const result = { pending: 0, prepared: 0, submitted: 0, failed: 0 };
  for (const row of db
    .select({ status: schema.fundingJobs.status, count: sql<number>`count(*)` })
    .from(schema.fundingJobs)
    .where(
      inArray(
        schema.fundingJobs.status,
        Object.keys(result) as (keyof typeof result)[],
      ),
    )
    .groupBy(schema.fundingJobs.status)
    .all()) {
    if (row.status in result)
      result[row.status as keyof typeof result] = Number(row.count);
  }
  return result;
}
