import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { registerAdminCommands } from "./admin/commands.js";
import { registerAdminRoutes } from "./admin/routes.js";
import {
  createTurnstileVerifier,
  type TurnstileVerifier,
} from "./auth/turnstile.js";
import { needsCatchUpBackup, nextBackupDelayMs, runBackup } from "./backup.js";
import {
  createFundingScheduler,
  FundingGauges,
  registerFundingCommands,
  runFundingExecutor,
} from "./bonuses/funding.js";
import { registerBonusCommands } from "./bonuses/lifecycle.js";
import { createOptInWatchLauncher } from "./bonuses/optin.js";
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
import { nonOverlapping } from "./non-overlapping.js";
import { OperationalAlerts } from "./operations/alerts.js";
import {
  OperationalState,
  probeFacilitator,
  registerOperationalCommands,
  runReconciliation,
} from "./operations/reconciliation.js";
import { pruneSettledPaymentIntents } from "./operations/retention.js";
import {
  registerPayoutCommands,
  runPayoutExecutor,
} from "./payouts/executor.js";
import { createPaymentRail } from "./rail/factory.js";
import { createGuardedRail } from "./rail/guard.js";
import { completeBootRecovery, recoverSettlingIntents } from "./recovery.js";

export * from "./admin/auth.js";
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
export * from "./operations/retention.js";
export * from "./payouts/executor.js";
export * from "./rail/factory.js";
export * from "./recovery.js";
export * from "./replays.js";

const POOL_TICK_INTERVAL_MS = 60_000;
const PAYOUT_TICK_INTERVAL_MS = 2_000;
const NUDGE_TICK_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 86_400_000;
/** Ceiling on funding-scheduler sleep so a missed kick can never park the
 * executor forever (F1, spec 2026-08-26). */
const FUNDING_MAX_SLEEP_MS = 60_000;
/** Delay between boot-gate recovery sweeps while the rail errs (F3). */
const BOOT_RECOVERY_RETRY_MS = 5_000;

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
      onDiagnostic: (event) => {
        logger.warn({ rail: event }, "rail response malformed");
      },
    });
  } catch (error) {
    logger.fatal(
      { err: error, rail: loaded.env.RAIL },
      "payment rail initialization failed",
    );
    process.exitCode = 1;
    return;
  }
  // Per-dependency circuit breaker + concurrency cap around every outbound
  // rail call (F2, spec 2026-08-26). Request traffic uses the capped handle;
  // probes, reconciliation, and recovery use the priority handle so they can
  // canary an open breaker and are never starved by request load.
  const railGuard = createGuardedRail({
    rail,
    now: Date.now,
    maxConcurrent: () => config.RAIL_MAX_CONCURRENT_CALLS,
  });
  const priorityRail = railGuard.priorityRail;
  rail = railGuard.rail;

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
  const bonusLifecycleDeps = {
    coordinator,
    db,
    config: () => config,
  } as const;
  registerBonusCommands(bonusLifecycleDeps);
  const alerts = new OperationalAlerts({
    url: loaded.env.ALERT_WEBHOOK_URL,
    telegram:
      loaded.env.TELEGRAM_BOT_TOKEN !== undefined &&
      loaded.env.TELEGRAM_CHAT_ID !== undefined
        ? {
            botToken: loaded.env.TELEGRAM_BOT_TOKEN,
            chatId: loaded.env.TELEGRAM_CHAT_ID,
          }
        : undefined,
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
  const metrics = new Metrics({ now: Date.now });
  const operationalDeps = {
    coordinator,
    db,
    rail: priorityRail,
    config: () => config,
    now: Date.now,
    alerts,
    state: operationalState,
    secrets: secretValues(loaded.env),
    metrics,
  } as const;
  registerOperationalCommands(operationalDeps);
  const events = new EventStreamService({
    sqlite,
    db,
    config: () => config,
    now: Date.now,
    logger,
  });
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
  const fundingGauges = new FundingGauges();
  const fundingDeps = {
    coordinator,
    db,
    rail,
    config: () => config,
    now: Date.now,
    logger,
    alerts,
    gauges: fundingGauges,
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
      const sweep = await recoverSettlingIntents(
        { ...claimDeps, rail: priorityRail },
        logger,
      );
      if (sweep.nextRecoveryAt !== null) scheduleRecovery(sweep.nextRecoveryAt);
    } catch (error) {
      logger.error({ err: error }, "payment recovery failed; retrying");
      scheduleRecovery(Date.now() + 1_000);
    }
  };
  const runPayouts = nonOverlapping(async () => {
    try {
      await runPayoutExecutor(payoutDeps);
    } catch (error) {
      logger.error({ err: error }, "payout executor pass failed");
    }
  });
  // The funding scheduler serializes passes and sleeps until each pass's own
  // nextDue (capped), so idle bonuses cost nothing between kicks (F1, spec
  // 2026-08-26). Work-creating events kick it: bonus claim, opt-in
  // observation, admin retry/revive.
  const fundingScheduler = createFundingScheduler({
    run: async () => {
      try {
        return await runFundingExecutor(fundingDeps);
      } catch (error) {
        logger.error(
          { err: error },
          "starter-stake funding executor pass failed",
        );
        return null;
      }
    },
    now: Date.now,
    maxDelayMs: FUNDING_MAX_SLEEP_MS,
  });
  const runFunding = () => fundingScheduler.kick();
  // Boot gate (F3, spec 2026-08-26): the network-bound recovery chain runs
  // AFTER the listener starts (see below) so an upstream outage can never
  // leave the site dark; until it clears, the `boot` pause cause plus the
  // warming middleware keep every mutating route closed.
  let bootGateActive = true;
  let shuttingDown = false;
  const runBootRecovery = async (): Promise<void> => {
    // Warm AVM fee-payer state and persist only the facilitator pause cause
    // before recovery. Recovery remains live while discretionary funding
    // sees the resulting pause through its send guard.
    await probeFacilitator(operationalDeps);
    const completed = await completeBootRecovery(
      { ...claimDeps, rail: priorityRail },
      {
        logger,
        retryDelayMs: BOOT_RECOVERY_RETRY_MS,
        shouldContinue: () => !shuttingDown,
      },
    );
    if (!completed) return;
    bootGateActive = false;
    logger.info({}, "boot gate cleared");
    // Arm the normal recovery scheduling for whatever the gate sweep left
    // pending, then resume the discretionary executors.
    void runRecovery();
    await runPayouts();
    await runBonusWatcher({ coordinator, db, rail, now: Date.now });
    await runFunding();
    try {
      await runReconciliation(operationalDeps, "boot");
    } catch (error) {
      logger.error({ err: error }, "boot reconciliation unavailable");
    }
  };
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
  pruneSettledPaymentIntents(db, now, config.PAYMENT_INTENT_RETENTION_DAYS);
  rearmTimers(db, timers, now, config.TIMER_REVEAL_SECONDS);
  await coordinator.dispatch({ type: "PoolTick", payload: {} });
  const poolInterval = setInterval(() => {
    void coordinator.dispatch({ type: "PoolTick", payload: {} });
  }, POOL_TICK_INTERVAL_MS);
  poolInterval.unref();
  // Money-moving background work must not run concurrently with mandatory
  // boot recovery; the boot chain runs each once after the gate clears
  // (F3 review, spec 2026-08-26).
  const payoutInterval = setInterval(() => {
    if (bootGateActive) return;
    void runPayouts();
  }, PAYOUT_TICK_INTERVAL_MS);
  payoutInterval.unref();
  const bonusWatchInterval = setInterval(() => {
    if (bootGateActive) return;
    void runBonusWatcher({ coordinator, db, rail, now: Date.now })
      .then((advanced) => {
        if (advanced > 0) void fundingScheduler.kick();
      })
      .catch((error) => {
        logger.error({ err: error }, "starter-stake watcher pass failed");
      });
  }, config.BONUS_WATCH_INTERVAL_SECONDS * 1_000);
  bonusWatchInterval.unref();
  const heartbeatInterval = setInterval(() => {
    events.heartbeat();
  }, config.SSE_HEARTBEAT_SECONDS * 1_000);
  heartbeatInterval.unref();
  const nudgeInterval = setInterval(() => {
    void coordinator.dispatch({ type: "NudgeTick", payload: {} });
  }, NUDGE_TICK_INTERVAL_MS);
  nudgeInterval.unref();
  const pruneInterval = setInterval(() => {
    events.prune();
    const deleted = pruneSettledPaymentIntents(
      db,
      Date.now(),
      config.PAYMENT_INTENT_RETENTION_DAYS,
    );
    if (deleted > 0) logger.info({ deleted }, "settled payment intents pruned");
  }, PRUNE_INTERVAL_MS);
  pruneInterval.unref();
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

  // The in-memory boot gate reads as paused so gameplay routes reject while
  // recovery is still running behind the already-listening server (F3).
  const mode = (): "running" | "paused" =>
    bootGateActive ? "paused" : currentMode(db);

  const app = createApp({
    logger,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    mode,
    bootActive: () => bootGateActive,
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
  const launchOptInWatch = createOptInWatchLauncher(
    {
      coordinator,
      rail,
      onFundingWork: () => {
        void fundingScheduler.kick();
      },
    },
    {
      attempts: 15,
      intervalMs: 2_000,
      onError: (error, player) => {
        logger.warn({ err: error, player }, "opt-in fast-path watch failed");
      },
    },
  );
  registerBonusRoutes(app, {
    ...humanDeps,
    onFundingWork: () => {
      void fundingScheduler.kick();
    },
    onOptInRelayed: (input) => {
      void launchOptInWatch(input);
    },
  });
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
    fundingGauges: () => fundingGauges.snapshot(),
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
    reconciliation: operationalDeps,
    funding: fundingDeps,
    fundingKick: () => {
      void fundingScheduler.kick();
    },
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
  void runBootRecovery().catch((error) => {
    logger.error({ err: error }, "boot recovery failed");
  });

  const shutdown = () => {
    shuttingDown = true;
    clearInterval(poolInterval);
    clearInterval(payoutInterval);
    clearInterval(bonusWatchInterval);
    fundingScheduler.stop();
    clearInterval(heartbeatInterval);
    clearInterval(nudgeInterval);
    clearInterval(pruneInterval);
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
