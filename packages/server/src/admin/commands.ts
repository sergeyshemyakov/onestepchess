import { and, eq, inArray } from "drizzle-orm";
import { applyConfigOverrides, type ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";
import {
  type ResolutionDeps,
  resolveTerminalGame,
} from "../coordinator/resolution.js";
import type { TimerService } from "../coordinator/timers.js";
import type { CoordinatorViews } from "../coordinator/views.js";
import { appendLedgerEntry } from "../db/ledger.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import type { OperationalAlerts } from "../operations/alerts.js";
import { readPauseState, updatePauseCause } from "../operations/pause.js";
import {
  type ReconciliationReport,
  readReconciliationReport,
} from "../operations/reconciliation.js";
import {
  configEditable,
  configEffect,
  isConfigKey,
  validateConfigValue,
} from "./config-metadata.js";

type ConfigMutationResult =
  | { readonly ok: true; readonly effect: string; readonly revision: number }
  | {
      readonly ok: false;
      readonly reason: "unknown" | "readonly" | "invalid";
      readonly details?: string;
    };

export type AdminCommandDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly views: CoordinatorViews;
  readonly timers: TimerService;
  readonly config: () => ServerConfig;
  readonly setConfig: (config: ServerConfig) => void;
  readonly baseConfig: ServerConfig;
  readonly resolution: ResolutionDeps;
  readonly alerts: OperationalAlerts;
};

function audit(
  deps: AdminCommandDeps,
  at: number,
  actor: string,
  action: string,
  payload: Record<string, unknown>,
): void {
  deps.db
    .insert(schema.auditLog)
    .values({
      ts: at,
      actor,
      action,
      payloadJson: JSON.stringify(payload),
    })
    .run();
}

function currentRevision(db: Db): number {
  return (
    db
      .select({ value: schema.systemState.configRevision })
      .from(schema.systemState)
      .get()?.value ?? 0
  );
}

export function registerAdminCommands(deps: AdminCommandDeps): void {
  deps.coordinator.register(
    "AdminPause",
    (
      ctx,
      payload: { readonly actor: string; readonly banner?: string | null },
    ) => {
      const result = updatePauseCause(deps.db, ctx, {
        cause: "manual",
        active: true,
        manualBanner: payload.banner,
      });
      audit(deps, ctx.now, payload.actor, "system.pause", {
        banner: result.state.banner,
        changed: result.changed,
      });
      ctx.afterCommit(() => {
        if (result.changed) {
          void deps.alerts.emit("manual_pause", {
            actor: payload.actor,
            banner: result.state.banner,
          });
        }
      });
      return result.state;
    },
  );

  deps.coordinator.register(
    "AdminResume",
    (ctx, payload: { readonly actor: string }) => {
      const result = updatePauseCause(deps.db, ctx, {
        cause: "manual",
        active: false,
      });
      audit(deps, ctx.now, payload.actor, "system.resume", {
        changed: result.changed,
        remainingCauses: result.state.causes,
      });
      return result.state;
    },
  );

  deps.coordinator.register(
    "AdminBan",
    (
      ctx,
      payload: {
        readonly actor: string;
        readonly address: string;
        readonly banned: boolean;
      },
    ) => {
      const changed = deps.db
        .update(schema.players)
        .set({ banned: payload.banned })
        .where(eq(schema.players.address, payload.address))
        .run().changes;
      audit(deps, ctx.now, payload.actor, "player.ban", {
        address: payload.address,
        banned: payload.banned,
      });
      return { found: changed > 0, banned: payload.banned };
    },
  );

  deps.coordinator.register(
    "AdminSetQuota",
    (
      ctx,
      payload: {
        readonly actor: string;
        readonly address: string;
        readonly override: number | null;
      },
    ) => {
      const changed = deps.db
        .update(schema.players)
        .set({ quotaOverride: payload.override })
        .where(eq(schema.players.address, payload.address))
        .run().changes;
      audit(deps, ctx.now, payload.actor, "player.quota", {
        address: payload.address,
        override: payload.override,
      });
      return { found: changed > 0, override: payload.override };
    },
  );

  deps.coordinator.register(
    "AdminSetConfig",
    (
      ctx,
      payload: {
        readonly actor: string;
        readonly key: string;
        readonly value: unknown;
      },
    ): ConfigMutationResult => {
      if (!isConfigKey(payload.key)) return { ok: false, reason: "unknown" };
      if (!configEditable(payload.key))
        return { ok: false, reason: "readonly" };
      let next: ServerConfig;
      try {
        next = validateConfigValue(deps.config(), payload.key, payload.value);
      } catch (error) {
        return {
          ok: false,
          reason: "invalid",
          details: error instanceof Error ? error.message : String(error),
        };
      }
      const effect = configEffect(payload.key);
      deps.db
        .insert(schema.configOverrides)
        .values({
          key: payload.key,
          valueJson: JSON.stringify(payload.value),
          updatedAt: ctx.now,
          updatedBy: payload.actor,
        })
        .onConflictDoUpdate({
          target: schema.configOverrides.key,
          set: {
            valueJson: JSON.stringify(payload.value),
            updatedAt: ctx.now,
            updatedBy: payload.actor,
          },
        })
        .run();
      let revision = currentRevision(deps.db);
      if (effect !== "restart") {
        revision += 1;
        deps.db
          .update(schema.systemState)
          .set({ configRevision: revision, updatedAt: ctx.now })
          .where(eq(schema.systemState.id, 1))
          .run();
        ctx.appendEvent("config_updated", null, {
          key: payload.key,
          revision,
          effect,
        });
        ctx.afterCommit(() => deps.setConfig(next));
      }
      audit(deps, ctx.now, payload.actor, "config.set", {
        key: payload.key,
        value: payload.value,
        effect,
        revision,
      });
      return { ok: true, effect, revision };
    },
  );

  deps.coordinator.register(
    "AdminRevertConfig",
    (
      ctx,
      payload: { readonly actor: string; readonly key: string },
    ): ConfigMutationResult => {
      if (!isConfigKey(payload.key)) return { ok: false, reason: "unknown" };
      if (!configEditable(payload.key))
        return { ok: false, reason: "readonly" };
      const existing = deps.db
        .select()
        .from(schema.configOverrides)
        .where(eq(schema.configOverrides.key, payload.key))
        .get();
      const effect = configEffect(payload.key);
      deps.db
        .delete(schema.configOverrides)
        .where(eq(schema.configOverrides.key, payload.key))
        .run();
      const rows = deps.db
        .select({
          key: schema.configOverrides.key,
          valueJson: schema.configOverrides.valueJson,
        })
        .from(schema.configOverrides)
        .all();
      const next = applyConfigOverrides(deps.baseConfig, rows);
      let revision = currentRevision(deps.db);
      if (existing !== undefined && effect !== "restart") {
        revision += 1;
        deps.db
          .update(schema.systemState)
          .set({ configRevision: revision, updatedAt: ctx.now })
          .where(eq(schema.systemState.id, 1))
          .run();
        ctx.appendEvent("config_updated", null, {
          key: payload.key,
          revision,
          effect,
          reverted: true,
        });
        ctx.afterCommit(() => deps.setConfig(next));
      }
      audit(deps, ctx.now, payload.actor, "config.revert", {
        key: payload.key,
        effect,
        revision,
        existed: existing !== undefined,
      });
      return { ok: true, effect, revision };
    },
  );

  deps.coordinator.register(
    "AdminAbort",
    (ctx, payload: { readonly actor: string; readonly gameId: string }) => {
      const game = deps.db
        .select()
        .from(schema.games)
        .where(eq(schema.games.id, payload.gameId))
        .get();
      if (game === undefined) return { status: "not_found" as const };
      if (game.status === "finished") return { status: "terminal" as const };
      if (game.status === "aborted") {
        const jobs = deps.db
          .select({ id: schema.payoutJobs.id })
          .from(schema.payoutJobs)
          .where(eq(schema.payoutJobs.gameId, game.id))
          .all().length;
        return {
          status: "aborted" as const,
          gameId: game.id,
          refundJobs: jobs,
        };
      }
      const openClaim = deps.db
        .select()
        .from(schema.claims)
        .where(
          and(
            eq(schema.claims.gameId, game.id),
            eq(schema.claims.status, "open"),
          ),
        )
        .get();
      if (openClaim !== undefined) {
        const inFlight = deps.db
          .select({ id: schema.paymentIntents.id })
          .from(schema.paymentIntents)
          .where(
            and(
              eq(schema.paymentIntents.claimId, openClaim.id),
              inArray(schema.paymentIntents.status, ["verified", "settling"]),
            ),
          )
          .get();
        if (inFlight !== undefined)
          return { status: "payment_in_flight" as const };
        deps.db
          .update(schema.claims)
          .set({ status: "expired" })
          .where(eq(schema.claims.id, openClaim.id))
          .run();
        ctx.afterCommit(() => {
          deps.views.removeOpenClaim(openClaim.id);
          deps.timers.disarm("claimReveal", openClaim.id);
          deps.timers.disarm("claimDeadline", openClaim.id);
        });
      }
      deps.db
        .update(schema.games)
        .set({
          status: "aborted",
          result: "aborted",
          termination: "aborted",
          finishedAt: ctx.now,
        })
        .where(eq(schema.games.id, game.id))
        .run();
      const resolution = resolveTerminalGame(deps.resolution, ctx, game.id);
      audit(deps, ctx.now, payload.actor, "game.abort", {
        gameId: game.id,
        refundJobs: "jobs" in resolution ? resolution.jobs : 0,
      });
      ctx.afterCommit(() => {
        deps.views.games.delete(game.id);
      });
      return {
        status: "aborted" as const,
        gameId: game.id,
        refundJobs: "jobs" in resolution ? resolution.jobs : 0,
      };
    },
  );

  deps.coordinator.register(
    "AdminTreasuryAdjustment",
    (
      ctx,
      payload: {
        readonly actor: string;
        readonly deltaMicroUsdc: number;
        readonly reason: string;
      },
    ) => {
      if (readPauseState(deps.db).mode !== "paused") {
        return { status: "not_paused" as const };
      }
      const report = readReconciliationReport(deps.db);
      if (
        report === null ||
        report.ok ||
        payload.deltaMicroUsdc !== -report.driftMicroUsdc
      ) {
        return {
          status: "drift_mismatch" as const,
          expectedDeltaMicroUsdc:
            report === null ? null : -report.driftMicroUsdc,
        };
      }
      appendLedgerEntry(deps.db, {
        ts: ctx.now,
        account: "treasury",
        deltaMicrousdc: payload.deltaMicroUsdc,
        refType: "adjustment",
        refId: `admin-adjustment:${ctx.now}`,
      });
      const next: ReconciliationReport = {
        ...report,
        lastRunAt: new Date(ctx.now).toISOString(),
        bookMicroUsdc: report.bookMicroUsdc + payload.deltaMicroUsdc,
        driftMicroUsdc: 0,
        ok: true,
      };
      deps.db
        .update(schema.systemState)
        .set({
          lastReconcileAt: ctx.now,
          lastReconcileJson: JSON.stringify(next),
          updatedAt: ctx.now,
        })
        .where(eq(schema.systemState.id, 1))
        .run();
      updatePauseCause(deps.db, ctx, {
        cause: "reconciliation",
        active: false,
      });
      audit(deps, ctx.now, payload.actor, "treasury.adjust", {
        deltaMicroUsdc: payload.deltaMicroUsdc,
        reason: payload.reason,
      });
      return { status: "adjusted" as const, reconciliation: next };
    },
  );

  deps.coordinator.register(
    "AdminPayoutRetry",
    (ctx, payload: { readonly actor: string; readonly payoutId: string }) => {
      const job = deps.db
        .select()
        .from(schema.payoutJobs)
        .where(eq(schema.payoutJobs.id, payload.payoutId))
        .get();
      if (job === undefined) return { status: "not_found" as const };
      if (job.status !== "failed") return { status: "not_failed" as const };
      deps.db
        .update(schema.payoutJobs)
        .set({
          status: "pending",
          attempts: 0,
          nextAttemptAt: null,
          batchId: null,
          txid: null,
        })
        .where(eq(schema.payoutJobs.id, job.id))
        .run();
      audit(deps, ctx.now, payload.actor, "payout.retry", {
        payoutId: job.id,
      });
      return { status: "pending" as const, payoutId: job.id };
    },
  );
}
