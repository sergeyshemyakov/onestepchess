import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createMockRail } from "@onestepchess/rail-mock";
import {
  createTurnstileVerifier,
  type TurnstileVerifier,
} from "./auth/turnstile.js";
import {
  applyConfigOverrides,
  ConfigError,
  type LoadedConfig,
  loadConfig,
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
import { createApp } from "./http/app.js";
import { registerAuthRoutes } from "./http/routes/auth.js";
import { registerClaimRoutes } from "./http/routes/claims.js";
import { registerDiscoveryRoutes } from "./http/routes/discovery.js";
import { createLogger } from "./logger.js";
import {
  registerPayoutCommands,
  runPayoutExecutor,
} from "./payouts/executor.js";
import {
  recoverSettlingIntents,
  recoverUnresolvedTerminalGames,
} from "./recovery.js";

export * from "./auth/challenge.js";
export * from "./auth/genesis.js";
export * from "./auth/jwt.js";
export * from "./auth/turnstile.js";
export * from "./auth/verify-arc60.js";
export * from "./auth/verify-txn.js";
export * from "./config.js";
export * from "./coordinator/chess-registry.js";
export * from "./coordinator/claims.js";
export * from "./coordinator/lifecycle.js";
export * from "./coordinator/queue.js";
export * from "./coordinator/resolution.js";
export * from "./coordinator/timers.js";
export * from "./coordinator/views.js";
export * from "./db/open.js";
export * from "./http/app.js";
export * from "./http/middleware/client-ip.js";
export * from "./http/middleware/ratelimit.js";
export * from "./http/routes/auth.js";
export * from "./http/routes/claims.js";
export * from "./http/routes/discovery.js";
export * from "./ids.js";
export * from "./logger.js";
export * from "./names.js";
export * from "./payouts/executor.js";
export * from "./recovery.js";

const POOL_TICK_INTERVAL_MS = 60_000;
const PAYOUT_TICK_INTERVAL_MS = 2_000;

export async function main(): Promise<void> {
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig();
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
  const config = applyConfigOverrides(loaded.config, overrideRows);

  if (loaded.env.RAIL !== "mock") {
    // rail-avm wiring lands with the move-path slice; Release 1 runs on the
    // mock profile only (release plan; ADR 0001 keeps CI mock-only anyway).
    logger.fatal({ rail: loaded.env.RAIL }, "only RAIL=mock is wired yet");
    process.exitCode = 1;
    return;
  }
  const rail = createMockRail();

  // The DB's rail identity is pinned on first boot; a mismatch on any later
  // boot refuses to start rather than recover on another chain (§5).
  const now = Date.now();
  const identity = db.select().from(schema.systemState).get();
  if (identity === undefined) {
    db.insert(schema.systemState)
      .values({
        id: 1,
        railKind: loaded.env.RAIL,
        caip2: config.CAIP2,
        usdcAsset: config.USDC_ASA,
        treasuryAddress: rail.treasuryAddress,
        pauseCausesJson: "[]",
        banner: loaded.env.SYSTEM_BANNER ?? null,
        updatedAt: now,
      })
      .run();
  } else if (
    identity.railKind !== loaded.env.RAIL ||
    identity.caip2 !== config.CAIP2 ||
    identity.usdcAsset !== config.USDC_ASA ||
    identity.treasuryAddress !== rail.treasuryAddress
  ) {
    logger.fatal(
      {
        stored: {
          railKind: identity.railKind,
          caip2: identity.caip2,
          usdcAsset: identity.usdcAsset,
        },
        configured: {
          railKind: loaded.env.RAIL,
          caip2: config.CAIP2,
          usdcAsset: config.USDC_ASA,
        },
      },
      "rail identity mismatch — refusing to start (migration required)",
    );
    process.exitCode = 1;
    return;
  }
  if (
    loaded.env.SYSTEM_BANNER !== undefined &&
    identity !== undefined &&
    identity.banner !== loaded.env.SYSTEM_BANNER
  ) {
    db.update(schema.systemState)
      .set({ banner: loaded.env.SYSTEM_BANNER, updatedAt: now })
      .run();
  }

  const views = new CoordinatorViews();
  views.rebuild(db, now);
  const coordinator = new Coordinator({ sqlite, db, logger, views });
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
  });
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
  } as const;
  registerClaimCommands(claimDeps);
  registerResolution({ coordinator, db, logger });
  const payoutDeps = {
    coordinator,
    db,
    rail,
    config: () => config,
    now: Date.now,
    logger,
  } as const;
  registerPayoutCommands(payoutDeps);
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
      const nextRecoveryAt = await recoverSettlingIntents(claimDeps);
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
  await runRecovery();
  await recoverUnresolvedTerminalGames(claimDeps);
  // Resume payout batches and pay out any freshly-recovered resolutions
  // (F1 step 6) before serving.
  await runPayouts();
  rearmTimers(db, timers, now);
  await coordinator.dispatch({ type: "PoolTick", payload: {} });
  const poolInterval = setInterval(() => {
    void coordinator.dispatch({ type: "PoolTick", payload: {} });
  }, POOL_TICK_INTERVAL_MS);
  poolInterval.unref();
  const payoutInterval = setInterval(() => {
    void runPayouts();
  }, PAYOUT_TICK_INTERVAL_MS);
  payoutInterval.unref();

  const mode = (): "running" | "paused" => {
    const row = db
      .select({ pauseCausesJson: schema.systemState.pauseCausesJson })
      .from(schema.systemState)
      .get();
    const causes =
      row === undefined ? [] : (JSON.parse(row.pauseCausesJson) as string[]);
    return causes.length > 0 ? "paused" : "running";
  };

  const app = createApp({
    logger,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    mode,
  });

  let turnstile: TurnstileVerifier;
  if (loaded.env.TURNSTILE_SECRET !== undefined) {
    turnstile = createTurnstileVerifier({
      secret: loaded.env.TURNSTILE_SECRET,
    });
  } else {
    // Reachable only on the mock profile (avm exits above): local dev has no
    // Turnstile keys, and CI drives the fixture verifier through tests.
    logger.warn("TURNSTILE_SECRET unset — dev verifier accepts any token");
    turnstile = async () => "pass";
  }
  registerAuthRoutes(app, {
    db,
    rail,
    config: () => config,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    jwtSecret: loaded.env.JWT_SECRET,
    trustProxyHops: loaded.env.TRUST_PROXY_HOPS,
    turnstile,
    now: Date.now,
    rng: Math.random,
  });
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
  });
  registerDiscoveryRoutes(app, {
    db,
    config: () => config,
    jwtSecret: loaded.env.JWT_SECRET,
    now: Date.now,
    views,
    mode,
    rail,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    staticDir: new URL("../../web/dist", import.meta.url).pathname,
  });

  const server = serve({ fetch: app.fetch, port: loaded.env.PORT }, (info) => {
    logger.info({ port: info.port, rail: loaded.env.RAIL }, "listening");
  });

  const shutdown = () => {
    clearInterval(poolInterval);
    clearInterval(payoutInterval);
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    timers.disarmAll();
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
