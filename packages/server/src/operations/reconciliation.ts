import type { PaymentRail } from "@onestepchess/core";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";
import { appendLedgerEntry } from "../db/ledger.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import {
  type OperationalAlerts,
  sanitizeOperationalPayload,
} from "./alerts.js";
import { updatePauseCause } from "./pause.js";

export type ReconciliationReport = {
  readonly lastRunAt: string;
  readonly bookMicroUsdc: number;
  readonly chainMicroUsdc: number;
  readonly driftMicroUsdc: number;
  readonly inboundToleranceMicroUsdc: number;
  readonly outboundToleranceMicroUsdc: number;
  readonly ok: boolean;
  readonly belowRefundCoverage: boolean;
  readonly algoBelowFloor: boolean;
  readonly aboveTreasuryCap: boolean;
  readonly bonusUsdcMicroUsdc: number;
  readonly bonusAlgoMicroAlgo: number;
  readonly bonusLow: boolean;
};

export class OperationalState {
  facilitator = {
    healthy: true,
    lastCheckAt: null as number | null,
    consecutiveFailures: 0,
    alerted: false,
    unhealthySince: null as number | null,
  };
}

/** Alerts debounce to this many consecutive failed probes; the pause cause
 * still activates on the first failure (F6, spec 2026-08-26). */
export const FACILITATOR_ALERT_AFTER_FAILURES = 3;

/** The chain balance is read before the book, and balance queries can trail a
 * facilitator-confirmed transaction by a few rounds — so ledger entries booked
 * inside this window may legitimately be absent from the chain figure. Without
 * it every reconciliation that races an in-flight settlement raises a false
 * drift alarm and pauses gameplay. */
export const CHAIN_BALANCE_SKEW_MS = 30_000;

export type ReconciliationDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly config: () => ServerConfig;
  readonly now: () => number;
  readonly alerts: OperationalAlerts;
  readonly state: OperationalState;
  readonly secrets?: readonly string[];
  readonly metrics?: {
    recordRailUnhealthySeconds(seconds: number): void;
  };
};

function scalar(value: unknown): number {
  return Number(value ?? 0);
}

function accountBalance(db: Db, account: string): number {
  return (
    db
      .select({ value: schema.ledgerBalances.balanceMicrousdc })
      .from(schema.ledgerBalances)
      .where(eq(schema.ledgerBalances.account, account))
      .get()?.value ?? 0
  );
}

export function refundCoverageRequiredMicroUsdc(db: Db): number {
  const unresolvedStakes = scalar(
    db
      .select({
        amount: sql<number>`coalesce(sum(${schema.stakeEntries.amount}), 0)`,
      })
      .from(schema.stakeEntries)
      .innerJoin(schema.games, eq(schema.games.id, schema.stakeEntries.gameId))
      .where(inArray(schema.games.status, ["active", "endspiel"]))
      .get()?.amount,
  );
  const unbroadcastPayouts = scalar(
    db
      .select({
        amount: sql<number>`coalesce(sum(${schema.payoutJobs.amount}), 0)`,
      })
      .from(schema.payoutJobs)
      .where(inArray(schema.payoutJobs.status, ["pending", "prepared"]))
      .get()?.amount,
  );
  return unresolvedStakes + unbroadcastPayouts;
}

export function readReconciliationReport(db: Db): ReconciliationReport | null {
  const raw = db
    .select({ value: schema.systemState.lastReconcileJson })
    .from(schema.systemState)
    .get()?.value;
  return raw === null || raw === undefined
    ? null
    : (JSON.parse(raw) as ReconciliationReport);
}

export function registerOperationalCommands(deps: ReconciliationDeps): void {
  deps.coordinator.register(
    "ReconciliationApplied",
    (
      ctx,
      payload: {
        readonly usdcMicroUsdc: number;
        readonly algoMicroAlgo: number;
        readonly bonusUsdcMicroUsdc: number;
        readonly bonusAlgoMicroAlgo: number;
        readonly source: "boot" | "scheduled" | "admin";
        readonly actor?: string;
      },
    ) => {
      const history =
        deps.db
          .select({ count: sql<number>`count(*)` })
          .from(schema.ledger)
          .get()?.count ?? 0;
      if (history === 0) {
        appendLedgerEntry(deps.db, {
          ts: ctx.now,
          account: "treasury",
          deltaMicrousdc: payload.usdcMicroUsdc,
          refType: "opening",
          refId: "treasury-opening",
        });
      }

      const inboundTolerance = scalar(
        deps.db
          .select({
            amount: sql<number>`coalesce(sum(${schema.paymentIntents.amount}), 0)`,
          })
          .from(schema.paymentIntents)
          .where(eq(schema.paymentIntents.status, "settling"))
          .get()?.amount,
      );
      const outboundTolerance = scalar(
        deps.db
          .select({
            amount: sql<number>`coalesce(sum(${schema.payoutJobs.amount}), 0)`,
          })
          .from(schema.payoutJobs)
          .where(eq(schema.payoutJobs.status, "submitted"))
          .get()?.amount,
      );
      const skewCutoff = ctx.now - CHAIN_BALANCE_SKEW_MS;
      const recentInboundBook = scalar(
        deps.db
          .select({
            amount: sql<number>`coalesce(sum(${schema.ledger.deltaMicrousdc}), 0)`,
          })
          .from(schema.ledger)
          .where(
            and(
              eq(schema.ledger.refType, "stake"),
              gt(schema.ledger.ts, skewCutoff),
            ),
          )
          .get()?.amount,
      );
      const recentOutboundBook = -scalar(
        deps.db
          .select({
            amount: sql<number>`coalesce(sum(${schema.ledger.deltaMicrousdc}), 0)`,
          })
          .from(schema.ledger)
          .where(
            and(
              eq(schema.ledger.refType, "payout"),
              gt(schema.ledger.ts, skewCutoff),
            ),
          )
          .get()?.amount,
      );
      const totalInboundTolerance = inboundTolerance + recentOutboundBook;
      const totalOutboundTolerance = outboundTolerance + recentInboundBook;
      const book =
        accountBalance(deps.db, "treasury") +
        accountBalance(deps.db, "protocol");
      const drift = book - payload.usdcMicroUsdc;
      const ok =
        drift >= -totalInboundTolerance && drift <= totalOutboundTolerance;
      const requiredRefundCoverage = refundCoverageRequiredMicroUsdc(deps.db);
      const belowRefundCoverage =
        payload.usdcMicroUsdc < requiredRefundCoverage;
      const cfg = deps.config();
      const bonusLow =
        payload.bonusAlgoMicroAlgo < cfg.BONUS_MIN_ALGO_MICRO ||
        payload.bonusUsdcMicroUsdc < cfg.BONUS_USDC_MICRO;
      const previousReport = readReconciliationReport(deps.db);
      const report: ReconciliationReport = {
        lastRunAt: new Date(ctx.now).toISOString(),
        bookMicroUsdc: book,
        chainMicroUsdc: payload.usdcMicroUsdc,
        driftMicroUsdc: drift,
        inboundToleranceMicroUsdc: totalInboundTolerance,
        outboundToleranceMicroUsdc: totalOutboundTolerance,
        ok,
        belowRefundCoverage,
        algoBelowFloor: payload.algoMicroAlgo < cfg.TREASURY_MIN_ALGO_MICRO,
        aboveTreasuryCap: payload.usdcMicroUsdc > cfg.TREASURY_CAP_MICROUSDC,
        bonusUsdcMicroUsdc: payload.bonusUsdcMicroUsdc,
        bonusAlgoMicroAlgo: payload.bonusAlgoMicroAlgo,
        bonusLow,
      };
      updatePauseCause(deps.db, ctx, {
        cause: "reconciliation_dependency",
        active: false,
      });
      deps.db
        .update(schema.systemState)
        .set({
          lastReconcileAt: ctx.now,
          lastReconcileJson: JSON.stringify(report),
          updatedAt: ctx.now,
        })
        .where(eq(schema.systemState.id, 1))
        .run();
      if (payload.source === "admin" && payload.actor !== undefined) {
        deps.db
          .insert(schema.auditLog)
          .values({
            ts: ctx.now,
            actor: payload.actor,
            action: "treasury.reconcile",
            payloadJson: JSON.stringify({
              driftMicroUsdc: report.driftMicroUsdc,
              ok: report.ok,
            }),
          })
          .run();
      }

      // Drift alerts the operator but never pauses gameplay: small transient
      // drifts from facilitator/algod quirks are cheaper to reconcile offline
      // than an automatic halt (ADR 0007). Clearing the cause here also
      // releases any drift pause persisted before this policy change.
      updatePauseCause(deps.db, ctx, {
        cause: "reconciliation",
        active: false,
      });
      // Debounce on the ok -> drift transition so the scheduled loop does not
      // re-alert every cycle while a known drift awaits investigation.
      if (!ok && (previousReport === null || previousReport.ok)) {
        deps.db
          .insert(schema.errorLog)
          .values({
            ts: ctx.now,
            level: "error",
            code: "reconciliation_drift",
            requestId: null,
            contextJson: JSON.stringify({
              driftMicroUsdc: drift,
              inboundToleranceMicroUsdc: totalInboundTolerance,
              outboundToleranceMicroUsdc: totalOutboundTolerance,
            }),
          })
          .run();
        ctx.afterCommit(() => {
          void deps.alerts.emit("reconciliation_drift", {
            driftMicroUsdc: drift,
            inboundToleranceMicroUsdc: totalInboundTolerance,
            outboundToleranceMicroUsdc: totalOutboundTolerance,
          });
        });
      }
      const treasuryChanged = updatePauseCause(deps.db, ctx, {
        cause: "treasury",
        active: belowRefundCoverage,
      }).changed;
      if (treasuryChanged && belowRefundCoverage) {
        ctx.afterCommit(() => {
          void deps.alerts.emit("treasury_refund_coverage", {
            chainMicroUsdc: payload.usdcMicroUsdc,
            requiredMicroUsdc: requiredRefundCoverage,
          });
        });
      }
      if (report.algoBelowFloor) {
        ctx.afterCommit(() => {
          void deps.alerts.emit("treasury_algo_floor", {
            algoMicroAlgo: payload.algoMicroAlgo,
          });
        });
      }
      if (report.aboveTreasuryCap) {
        ctx.afterCommit(() => {
          void deps.alerts.emit("treasury_cap", {
            usdcMicroUsdc: payload.usdcMicroUsdc,
          });
        });
      }
      // A drained bonus account only defers bonuses (the funding send guard
      // already skips), so this alerts without adding a pause cause.
      if (bonusLow) {
        ctx.afterCommit(() => {
          void deps.alerts.emit("bonus_account_low", {
            usdcMicroUsdc: payload.bonusUsdcMicroUsdc,
            algoMicroAlgo: payload.bonusAlgoMicroAlgo,
          });
        });
      }
      return report;
    },
  );

  deps.coordinator.register(
    "ReconciliationUnavailable",
    (ctx, payload: { readonly message: string }) => {
      const message = sanitizeOperationalPayload(
        payload.message,
        deps.secrets,
      ) as string;
      const changed = updatePauseCause(deps.db, ctx, {
        cause: "reconciliation_dependency",
        active: true,
      }).changed;
      if (changed) {
        deps.db
          .insert(schema.errorLog)
          .values({
            ts: ctx.now,
            level: "error",
            code: "reconciliation_unavailable",
            requestId: null,
            contextJson: JSON.stringify({ message }),
          })
          .run();
        ctx.afterCommit(() => {
          void deps.alerts.emit("reconciliation_unavailable", {
            message,
          });
        });
      }
    },
  );

  deps.coordinator.register(
    "FacilitatorHealthChanged",
    (
      ctx,
      payload: { readonly healthy: boolean; readonly checkedAt: number },
    ) => {
      const previous = deps.state.facilitator;
      const consecutiveFailures = payload.healthy
        ? 0
        : previous.consecutiveFailures + 1;
      const shouldAlertUnhealthy =
        !payload.healthy &&
        !previous.alerted &&
        consecutiveFailures >= FACILITATOR_ALERT_AFTER_FAILURES;
      const shouldAlertRecovered = payload.healthy && previous.alerted;
      if (payload.healthy && previous.unhealthySince !== null) {
        deps.metrics?.recordRailUnhealthySeconds(
          Math.round((payload.checkedAt - previous.unhealthySince) / 1_000),
        );
      }
      deps.state.facilitator = {
        healthy: payload.healthy,
        lastCheckAt: payload.checkedAt,
        consecutiveFailures,
        alerted: shouldAlertUnhealthy || (previous.alerted && !payload.healthy),
        unhealthySince: payload.healthy
          ? null
          : (previous.unhealthySince ?? payload.checkedAt),
      };
      updatePauseCause(deps.db, ctx, {
        cause: "facilitator",
        active: !payload.healthy,
      });
      if (shouldAlertUnhealthy || shouldAlertRecovered) {
        ctx.afterCommit(() => {
          void deps.alerts.emit(
            payload.healthy ? "facilitator_recovered" : "facilitator_unhealthy",
          );
        });
      }
    },
  );
}

export async function runReconciliation(
  deps: ReconciliationDeps,
  source: "boot" | "scheduled" | "admin",
  actor?: string,
): Promise<ReconciliationReport> {
  let balances: Awaited<ReturnType<PaymentRail["getBalances"]>>;
  let bonusBalances: Awaited<ReturnType<PaymentRail["getBalances"]>>;
  try {
    balances = await deps.rail.getBalances(deps.rail.treasuryAddress);
    bonusBalances = await deps.rail.getBalances(deps.rail.bonusAddress);
  } catch (error) {
    await deps.coordinator.dispatch({
      type: "ReconciliationUnavailable",
      payload: {
        message:
          error instanceof Error ? error.message.slice(0, 500) : "unavailable",
      },
    });
    throw error;
  }
  const result = await deps.coordinator.dispatch<
    {
      usdcMicroUsdc: number;
      algoMicroAlgo: number;
      bonusUsdcMicroUsdc: number;
      bonusAlgoMicroAlgo: number;
      source: "boot" | "scheduled" | "admin";
      actor?: string;
    },
    ReconciliationReport
  >({
    type: "ReconciliationApplied",
    payload: {
      ...balances,
      bonusUsdcMicroUsdc: bonusBalances.usdcMicroUsdc,
      bonusAlgoMicroAlgo: bonusBalances.algoMicroAlgo,
      source,
      ...(actor === undefined ? {} : { actor }),
    },
    refIds: [source],
  });
  if (result.kind !== "ok") throw new Error("reconciliation was deprioritized");
  return result.result;
}

export async function probeFacilitator(
  deps: ReconciliationDeps,
): Promise<boolean> {
  let healthy = false;
  try {
    healthy = await deps.rail.health();
  } catch {
    healthy = false;
  }
  const checkedAt = deps.now();
  await deps.coordinator.dispatch({
    type: "FacilitatorHealthChanged",
    payload: { healthy, checkedAt },
  });
  return healthy;
}
