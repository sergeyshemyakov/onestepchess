import type { PaymentRail } from "@onestepchess/core";
import { eq, inArray, sql } from "drizzle-orm";
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
};

export class OperationalState {
  facilitator = { healthy: true, lastCheckAt: null as number | null };
}

export type ReconciliationDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly config: () => ServerConfig;
  readonly now: () => number;
  readonly alerts: OperationalAlerts;
  readonly state: OperationalState;
  readonly secrets?: readonly string[];
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
      const unresolvedStakes = scalar(
        deps.db
          .select({
            amount: sql<number>`coalesce(sum(${schema.stakeEntries.amount}), 0)`,
          })
          .from(schema.stakeEntries)
          .innerJoin(
            schema.games,
            eq(schema.games.id, schema.stakeEntries.gameId),
          )
          .where(inArray(schema.games.status, ["active", "endspiel"]))
          .get()?.amount,
      );
      const unbroadcastPayouts = scalar(
        deps.db
          .select({
            amount: sql<number>`coalesce(sum(${schema.payoutJobs.amount}), 0)`,
          })
          .from(schema.payoutJobs)
          .where(inArray(schema.payoutJobs.status, ["pending", "prepared"]))
          .get()?.amount,
      );
      const book =
        accountBalance(deps.db, "treasury") +
        accountBalance(deps.db, "protocol");
      const drift = book - payload.usdcMicroUsdc;
      const ok = drift >= -inboundTolerance && drift <= outboundTolerance;
      const belowRefundCoverage =
        payload.usdcMicroUsdc < unresolvedStakes + unbroadcastPayouts;
      const cfg = deps.config();
      const report: ReconciliationReport = {
        lastRunAt: new Date(ctx.now).toISOString(),
        bookMicroUsdc: book,
        chainMicroUsdc: payload.usdcMicroUsdc,
        driftMicroUsdc: drift,
        inboundToleranceMicroUsdc: inboundTolerance,
        outboundToleranceMicroUsdc: outboundTolerance,
        ok,
        belowRefundCoverage,
        algoBelowFloor: payload.algoMicroAlgo < cfg.TREASURY_MIN_ALGO_MICRO,
        aboveTreasuryCap: payload.usdcMicroUsdc > cfg.TREASURY_CAP_MICROUSDC,
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

      if (!ok) {
        const changed = updatePauseCause(deps.db, ctx, {
          cause: "reconciliation",
          active: true,
        }).changed;
        if (changed) {
          deps.db
            .insert(schema.errorLog)
            .values({
              ts: ctx.now,
              level: "error",
              code: "reconciliation_drift",
              requestId: null,
              contextJson: JSON.stringify({
                driftMicroUsdc: drift,
                inboundToleranceMicroUsdc: inboundTolerance,
                outboundToleranceMicroUsdc: outboundTolerance,
              }),
            })
            .run();
          ctx.afterCommit(() => {
            void deps.alerts.emit("reconciliation_drift", {
              driftMicroUsdc: drift,
              inboundToleranceMicroUsdc: inboundTolerance,
              outboundToleranceMicroUsdc: outboundTolerance,
            });
          });
        }
      }
      const treasuryChanged = updatePauseCause(deps.db, ctx, {
        cause: "treasury",
        active: belowRefundCoverage,
      }).changed;
      if (treasuryChanged && belowRefundCoverage) {
        ctx.afterCommit(() => {
          void deps.alerts.emit("treasury_refund_coverage", {
            chainMicroUsdc: payload.usdcMicroUsdc,
            requiredMicroUsdc: unresolvedStakes + unbroadcastPayouts,
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
      const before = deps.state.facilitator.healthy;
      deps.state.facilitator = {
        healthy: payload.healthy,
        lastCheckAt: payload.checkedAt,
      };
      updatePauseCause(deps.db, ctx, {
        cause: "facilitator",
        active: !payload.healthy,
      });
      if (before !== payload.healthy) {
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
  try {
    balances = await deps.rail.getBalances(deps.rail.treasuryAddress);
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
      source: "boot" | "scheduled" | "admin";
      actor?: string;
    },
    ReconciliationReport
  >({
    type: "ReconciliationApplied",
    payload: { ...balances, source, ...(actor === undefined ? {} : { actor }) },
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
