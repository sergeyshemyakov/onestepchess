import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { AdminReadCache } from "./admin/cache.js";
import { registerAdminCommands } from "./admin/commands.js";
import { registerAdminRoutes } from "./admin/routes.js";
import {
  createTurnstileVerifier,
  type TurnstileVerifier,
} from "./auth/turnstile.js";
import { needsCatchUpBackup, nextBackupDelayMs, runBackup } from "./backup.js";
import {
  registerFundingCommands,
  runFundingExecutor,
} from "./bonuses/funding.js";
import { registerBonusCommands } from "./bonuses/lifecycle.js";
import { registerBonusRoutes } from "./bonuses/routes.js";
import { runBonusWatcher } from "./bonuses/watcher.js";
import { currentMode, initializeSystemState } from "./boot.js";
import {
  applyConfigOverrides,
  ConfigError,
  type LoadedConfig,
  loadConfig,
  loadServerPackageEnvironment,
  secretValues,
} from "./config.js";
import { ChessAdapterRegistry } from "./coordinator/chess-registry.js";
import { registerClaimCommands } from "./coordinator/claims.js";
import { registerLifecycle } from "./coordinator/lifecycle.js";
import { Coordinator } from "./coordinator/queue.js";
import { registerResolution } from "./coordinator/resolution.js";
import { rearmTimers, TimerService } from "./coordinator/timers.js";
import { CoordinatorViews } from "./coordinator/views.js";
import { openDatabase, schema } from "./db/open.js";
import { registerNudgeCommands } from "./events/nudges.js";
import { EventStreamService } from "./events/service.js";
import { createApp } from "./http/app.js";
import { registerLlmsRoute } from "./http/llms-txt.js";
import { registerOpenApiRoute } from "./http/openapi.js";
import { registerAuthRoutes } from "./http/routes/auth.js";
import { registerClaimRoutes } from "./http/routes/claims.js";
import { registerDiscoveryRoutes } from "./http/routes/discovery.js";
import { registerEventRoutes } from "./http/routes/events.js";
import {
  registerHumanCommands,
  registerHumanRoutes,
} from "./http/routes/human.js";
import { jsonCompression, registerStaticRoutes } from "./http/static.js";
import { backfillPoints } from "./incentives/points.js";
import { PublicStats } from "./incentives/stats.js";
import { createLogger } from "./logger.js";
import { Metrics, registerMetricsRoute } from "./metrics.js";
import { OperationalAlerts } from "./operations/alerts.js";
import {
  OperationalState,
  probeFacilitator,
  registerOperationalCommands,
  runReconciliation,
} from "./operations/reconciliation.js";
import {
  registerPayoutCommands,
  runPayoutExecutor,
} from "./payouts/executor.js";
import { createPaymentRail } from "./rail/factory.js";
import {
  recoverSettlingIntents,
  recoverUnresolvedTerminalGames,
} from "./recovery.js";

export * from "./admin/auth.js";
export * from "./admin/cache.js";
export * from "./admin/commands.js";
export * from "./admin/config-metadata.js";
export * from "./admin/read-models.js";
export * from "./admin/routes.js";
export * from "./auth/challenge.js";
export * from "./auth/genesis.js";
export * from "./auth/jwt.js";
export * from "./auth/nickname.js";
export * from "./auth/turnstile.js";
export * from "./auth/verify-arc60.js";
export * from "./auth/verify-txn.js";
export * from "./backup.js";
export * from "./bonuses/funding.js";
export * from "./bonuses/lifecycle.js";
export * from "./bonuses/optin.js";
export * from "./bonuses/routes.js";
export * from "./bonuses/watcher.js";
export * from "./boot.js";
export * from "./config.js";
export * from "./coordinator/chess-registry.js";
export * from "./coordinator/claims.js";
export * from "./coordinator/lifecycle.js";
export * from "./coordinator/queue.js";
export * from "./coordinator/resolution.js";
export * from "./coordinator/timers.js";
export * from "./coordinator/views.js";
export * from "./db/open.js";
export * from "./events/nudges.js";
export * from "./events/service.js";
export * from "./http/app.js";
export * from "./http/contracts.js";
export * from "./http/llms-txt.js";
export * from "./http/middleware/client-ip.js";
export * from "./http/middleware/ratelimit.js";
export * from "./http/openapi.js";
export * from "./http/routes/auth.js";
export * from "./http/routes/claims.js";
export * from "./http/routes/discovery.js";
export * from "./http/routes/events.js";
export * from "./http/routes/human.js";
export * from "./http/static.js";
export * from "./http/turnstile.js";
export * from "./http/validation.js";
export * from "./http/views.js";
export * from "./ids.js";
export * from "./logger.js";
export * from "./markup.js";
export * from "./metrics.js";
export * from "./names.js";
export * from "./operations/alerts.js";
export * from "./operations/pause.js";
export * from "./operations/reconciliation.js";
export * from "./payouts/executor.js";
export * from "./rail/factory.js";
export * from "./recovery.js";
export * from "./replays.js";

const POOL_TICK_INTERVAL_MS = 60_000;
const PAYOUT_TICK_INTERVAL_MS = 2_000;
const NUDGE_TICK_INTERVAL_MS = 60_000;
const EVENT_PRUNE_INTERVAL_MS = 86_400_000;

export async function main(): Promise<void> {
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig({ env: loadServerPackageEnvironment() });
  } catch (error) {
    if (error instanceof ConfigError) {
      createLogger({ destination: process.stderr }).fatal(
        { keys: error.keys },
        error.message,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger({ secrets: secretValues(loaded.env) });

  // Migrations run at boot before anything else (server spec §4).
  const { sqlite, db } = openDatabase({ path: loaded.env.DB_PATH });
  const overrideRows = db
    .select({
      key: schema.configOverrides.key,
      valueJson: schema.configOverrides.valueJson,
    })
    .from(schema.configOverrides)
    .all();
  let config = applyConfigOverrides(loaded.config, overrideRows);

  const storedBook = (
    sqlite
      .prepare(
        "SELECT coalesce(sum(balance_microusdc), 0) AS amount FROM ledger_balances WHERE account IN ('treasury', 'protocol')",
      )
      .get() as { amount: number }
  ).amount;
  let rail: ReturnType<typeof createPaymentRail>;
  try {
    rail = createPaymentRail({
      env: loaded.env,
      config,
      storedBookMicroUsdc: storedBook,
    });
  } catch (error) {
    logger.fatal(
      { err: error, rail: loaded.env.RAIL },
      "payment rail initialization failed",
    );
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  if (
    !initializeSystemState({
      db,
      railKind: loaded.env.RAIL,
      config,
      treasuryAddress: rail.treasuryAddress,
      banner: loaded.env.SYSTEM_BANNER,
      now,
      logger,
    })
  ) {
    process.exitCode = 1;
    return;
  }

  const views = new CoordinatorViews();
  views.rebuild(db, now);
  const coordinator = new Coordinator({ sqlite, db, logger, views });
  const adminCache = new AdminReadCache(
    Date.now,
    () => config.ADMIN_CACHE_TTL_SECONDS,
  );
  const bonusLifecycleDeps = {
    coordinator,
    db,
    config: () => config,
    cache: adminCache,
  } as const;
  registerBonusCommands(bonusLifecycleDeps);
  const alerts = new OperationalAlerts({
    url: loaded.env.ALERT_WEBHOOK_URL,
    dedupeSeconds: () => config.ALERT_DEDUPE_SECONDS,
    now: Date.now,
    transport: (url, init) => fetch(url, init),
    logger,
    secrets: secretValues(loaded.env),
  });
  if (currentMode(db) === "paused") {
    void alerts.emit("boot_paused");
  }
  const operationalState = new OperationalState();
  const operationalDeps = {
    coordinator,
    db,
    rail,
    config: () => config,
    now: Date.now,
    alerts,
    state: operationalState,
    secrets: secretValues(loaded.env),
  } as const;
  registerOperationalCommands(operationalDeps);
  const events = new EventStreamService({
    sqlite,
    db,
    config: () => config,
    now: Date.now,
    logger,
  });
  const metrics = new Metrics({ now: Date.now });
  const publicStats = new PublicStats();
  const unsubscribeEvents = coordinator.onEvent((event) => {
    events.publish(event);
  });
  registerNudgeCommands({
    coordinator,
    db,
    views,
    config: () => config,
    connectedPlayers: () => events.connectedPlayers(),
  });
  const timers = new TimerService({
    now: Date.now,
    onFire: (kind, refId) => {
      void coordinator.dispatch({
        type: "TimerFired",
        payload: { kind, refId },
        refIds: [refId],
      });
    },
  });
  const registry = new ChessAdapterRegistry(8, {
    historyCacheSize: 2 * config.GAME_POOL_TARGET,
  });
  const lifecycle = registerLifecycle({
    coordinator,
    db,
    views,
    timers,
    registry,
    config: () => config,
    rng: Math.random,
    logger,
    alerts,
  });
  let turnstile: TurnstileVerifier;
  if (loaded.env.TURNSTILE_SECRET !== undefined) {
    turnstile = createTurnstileVerifier({
      secret: loaded.env.TURNSTILE_SECRET,
    });
  } else {
    // Local mock dev has no Turnstile keys, and CI drives the fixture verifier
    // through tests. Supported AVM deployments are expected to provide one.
    logger.warn("TURNSTILE_SECRET unset — dev verifier accepts any token");
    turnstile = async () => "pass";
  }
  const claimDeps = {
    coordinator,
    db,
    views,
    timers,
    registry,
    lifecycle,
    config: () => config,
    rail,
    now: Date.now,
    rng: Math.random,
    turnstile,
    publicStats,
  } as const;
  registerClaimCommands(claimDeps);
  const resolutionDeps = {
    coordinator,
    db,
    logger,
    config: () => config,
    metrics,
    publicStats,
    alerts,
  } as const;
  registerResolution(resolutionDeps);
  registerAdminCommands({
    coordinator,
    db,
    views,
    timers,
    config: () => config,
    setConfig: (next) => {
      config = next;
    },
    baseConfig: loaded.config,
    resolution: resolutionDeps,
    alerts,
    cache: adminCache,
  });
  const payoutDeps = {
    coordinator,
    db,
    rail,
    config: () => config,
    now: Date.now,
    logger,
    metrics,
    alerts,
  } as const;
  registerPayoutCommands(payoutDeps);
  const fundingDeps = {
    coordinator,
    db,
    rail,
    config: () => config,
    now: Date.now,
    logger,
    alerts,
    cache: adminCache,
  } as const;
  registerFundingCommands(fundingDeps);
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRecovery = (dueAt: number): void => {
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(
      () => {
        recoveryTimer = undefined;
        void runRecovery();
      },
      Math.max(0, dueAt - Date.now()),
    );
    recoveryTimer.unref?.();
  };
  const runRecovery = async (): Promise<void> => {
    try {
      const nextRecoveryAt = await recoverSettlingIntents(claimDeps, logger);
      if (nextRecoveryAt !== null) scheduleRecovery(nextRecoveryAt);
    } catch (error) {
      logger.error({ err: error }, "payment recovery failed; retrying");
      scheduleRecovery(Date.now() + 1_000);
    }
  };
  const runPayouts = async (): Promise<void> => {
    try {
      await runPayoutExecutor(payoutDeps);
    } catch (error) {
      logger.error({ err: error }, "payout executor pass failed");
    }
  };
  const runFunding = async (): Promise<void> => {
    try {
      await runFundingExecutor(fundingDeps);
    } catch (error) {
      logger.error(
        { err: error },
        "starter-stake funding executor pass failed",
      );
    }
  };
  // Warm AVM fee-payer state and persist only the facilitator pause cause
  // before recovery. Recovery remains live while discretionary funding sees
  // the resulting pause through its send guard.
  await probeFacilitator(operationalDeps);
  await runRecovery();
  await recoverUnresolvedTerminalGames(claimDeps);
  // Resume payout batches and pay out any freshly-recovered resolutions
  // (F1 step 6) before serving.
  await runPayouts();
  await runBonusWatcher({ coordinator, db, rail });
  await runFunding();
  try {
    await runReconciliation(operationalDeps, "boot");
  } catch (error) {
    logger.error({ err: error }, "boot reconciliation unavailable");
  }
  // Deterministic, idempotent points backfill of pre-incentive history (F15
  // step 6); a no-op once every terminal game already has its award rows.
  // Gated with the award sites: enabling POINTS_ENABLED later backfills the
  // disabled stretch on the next boot.
  if (config.POINTS_ENABLED) {
    backfillPoints(db, now, {
      pointsMove: config.POINTS_MOVE,
      pointsWin: config.POINTS_WIN,
    });
  }
  // Public-stats counters are cumulative in memory, seeded from SQL at boot so
  // a restart converges to ground truth (F16 step 4).
  publicStats.rebuild(db);
  events.prune(now);
  rearmTimers(db, timers, now, config.TIMER_REVEAL_SECONDS);
  await coordinator.dispatch({ type: "PoolTick", payload: {} });
  const poolInterval = setInterval(() => {
    void coordinator.dispatch({ type: "PoolTick", payload: {} });
  }, POOL_TICK_INTERVAL_MS);
  poolInterval.unref();
  const payoutInterval = setInterval(() => {
    void runPayouts();
  }, PAYOUT_TICK_INTERVAL_MS);
  payoutInterval.unref();
  const bonusWatchInterval = setInterval(() => {
    void runBonusWatcher({ coordinator, db, rail }).catch((error) => {
      logger.error({ err: error }, "starter-stake watcher pass failed");
    });
  }, config.BONUS_WATCH_INTERVAL_SECONDS * 1_000);
  bonusWatchInterval.unref();
  const fundingInterval = setInterval(() => {
    void runFunding();
  }, PAYOUT_TICK_INTERVAL_MS);
  fundingInterval.unref();
  const heartbeatInterval = setInterval(() => {
    events.heartbeat();
  }, config.SSE_HEARTBEAT_SECONDS * 1_000);
  heartbeatInterval.unref();
  const nudgeInterval = setInterval(() => {
    void coordinator.dispatch({ type: "NudgeTick", payload: {} });
  }, NUDGE_TICK_INTERVAL_MS);
  nudgeInterval.unref();
  const eventPruneInterval = setInterval(() => {
    events.prune();
  }, EVENT_PRUNE_INTERVAL_MS);
  eventPruneInterval.unref();
  const facilitatorInterval = setInterval(() => {
    void probeFacilitator(operationalDeps).catch((error) => {
      logger.error({ err: error }, "facilitator probe command failed");
    });
  }, 60_000);
  facilitatorInterval.unref();
  const reconciliationInterval = setInterval(() => {
    void runReconciliation(operationalDeps, "scheduled").catch((error) => {
      logger.error({ err: error }, "scheduled reconciliation failed");
    });
  }, config.RECONCILE_INTERVAL_MINUTES * 60_000);
  reconciliationInterval.unref();

  // Nightly online snapshot at BACKUP_HOUR_UTC into a persistent-volume dir
  // (server spec §4). Default: a `backups/` sibling of the DB file.
  const backupDir =
    loaded.env.BACKUP_DIR ?? join(dirname(loaded.env.DB_PATH), "backups");
  let backupTimer: ReturnType<typeof setTimeout> | undefined;
  const startBackup = (): Promise<unknown> =>
    runBackup({
      sqlite,
      backupDir,
      retentionDays: config.BACKUP_RETENTION_DAYS,
      now: Date.now,
      logger,
    }).then((result) => {
      if (!result.ok) {
        return alerts.emit("backup_failure", {
          message: result.error.message,
        });
      }
      return undefined;
    });
  const scheduleBackup = (): void => {
    backupTimer = setTimeout(
      () => {
        void startBackup().finally(scheduleBackup);
      },
      nextBackupDelayMs(Date.now(), config.BACKUP_HOUR_UTC),
    );
    backupTimer.unref?.();
  };
  // Downtime that spans the nightly boundary leaves the newest snapshot days
  // old; take one now rather than waiting for the next boundary.
  if (needsCatchUpBackup(backupDir, Date.now(), config.BACKUP_HOUR_UTC)) {
    void startBackup();
  }
  scheduleBackup();

  const mode = (): "running" | "paused" => currentMode(db);

  const app = createApp({
    logger,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    mode,
    onAppError: (code) => {
      if (code === "QUOTA_OUT") metrics.recordQuotaRejection();
      else if (
        code === "INVALID_SIGNATURE" ||
        code === "NONCE_EXPIRED" ||
        code === "UNAUTHENTICATED" ||
        code === "REKEYED_UNSUPPORTED"
      )
        metrics.recordAuthFailure();
    },
  });

  const authDeps = {
    db,
    rail,
    config: () => config,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    jwtSecret: loaded.env.JWT_SECRET,
    trustProxyHops: loaded.env.TRUST_PROXY_HOPS,
    turnstile,
    now: Date.now,
    rng: Math.random,
    coordinator,
    publicStats,
  } as const;
  registerAuthRoutes(app, authDeps);
  registerClaimRoutes(app, {
    coordinator,
    db,
    views,
    timers,
    registry,
    lifecycle,
    config: () => config,
    rail,
    now: Date.now,
    rng: Math.random,
    jwtSecret: loaded.env.JWT_SECRET,
    trustProxyHops: loaded.env.TRUST_PROXY_HOPS,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    mode,
    turnstile,
    metrics,
    scheduleRecovery,
  });
  const humanDeps = {
    db,
    coordinator,
    rail,
    config: () => config,
    jwtSecret: loaded.env.JWT_SECRET,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    trustProxyHops: loaded.env.TRUST_PROXY_HOPS,
    now: Date.now,
    rng: Math.random,
  } as const;
  registerHumanCommands(humanDeps);
  // Replay JSON is the one API response served compressed (server spec §6.6).
  app.use("/api/v1/games/:id/replay", jsonCompression());
  registerHumanRoutes(app, humanDeps);
  registerBonusRoutes(app, humanDeps);
  registerEventRoutes(app, { ...authDeps, events });
  registerDiscoveryRoutes(app, {
    db,
    config: () => config,
    jwtSecret: loaded.env.JWT_SECRET,
    now: Date.now,
    views,
    mode,
    rail,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    publicStats,
  });
  registerLlmsRoute(app);
  registerOpenApiRoute(app, { publicBaseUrl: loaded.env.PUBLIC_BASE_URL });
  registerMetricsRoute(app, {
    metrics,
    views,
    clientCount: () => events.clientCount,
    mode,
    adminToken: loaded.env.ADMIN_TOKEN,
  });
  registerAdminRoutes(app, {
    db,
    jwtSecret: loaded.env.JWT_SECRET,
    adminToken: loaded.env.ADMIN_TOKEN,
    adminAddresses: loaded.env.ADMIN_ADDRESSES,
    now: Date.now,
    rail,
    views,
    config: () => config,
    baseConfig: loaded.config,
    state: operationalState,
    metrics,
    clientCount: () => events.clientCount,
    secrets: secretValues(loaded.env),
    coordinator,
    cache: adminCache,
    reconciliation: operationalDeps,
    funding: fundingDeps,
  });
  // Static SPA fallback is registered last so its `*` route never shadows an
  // API, discovery, or `/llms.txt` route (server spec §6.6).
  registerStaticRoutes(app, {
    staticDir: new URL("../../web/dist", import.meta.url).pathname,
    config: () => config,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    db,
  });

  const server = serve({ fetch: app.fetch, port: loaded.env.PORT }, (info) => {
    logger.info({ port: info.port, rail: loaded.env.RAIL }, "listening");
  });

  const shutdown = () => {
    clearInterval(poolInterval);
    clearInterval(payoutInterval);
    clearInterval(bonusWatchInterval);
    clearInterval(fundingInterval);
    clearInterval(heartbeatInterval);
    clearInterval(nudgeInterval);
    clearInterval(eventPruneInterval);
    clearInterval(facilitatorInterval);
    clearInterval(reconciliationInterval);
    if (backupTimer !== undefined) clearTimeout(backupTimer);
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    timers.disarmAll();
    unsubscribeEvents();
    events.closeAll();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error) => {
    createLogger({ destination: process.stderr }).fatal(
      { err: error },
      "server boot failed",
    );
    process.exitCode = 1;
  });
}
