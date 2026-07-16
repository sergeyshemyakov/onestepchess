import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createMockRail } from "@onestepchess/rail-mock";
import {
  applyConfigOverrides,
  ConfigError,
  type LoadedConfig,
  loadConfig,
  secretValues,
} from "./config.js";
import { ChessAdapterRegistry } from "./coordinator/chess-registry.js";
import { registerLifecycle } from "./coordinator/lifecycle.js";
import { Coordinator } from "./coordinator/queue.js";
import { rearmTimers, TimerService } from "./coordinator/timers.js";
import { CoordinatorViews } from "./coordinator/views.js";
import { openDatabase, schema } from "./db/open.js";
import { createApp } from "./http/app.js";
import { createLogger } from "./logger.js";

export * from "./config.js";
export * from "./coordinator/chess-registry.js";
export * from "./coordinator/lifecycle.js";
export * from "./coordinator/queue.js";
export * from "./coordinator/timers.js";
export * from "./coordinator/views.js";
export * from "./db/open.js";
export * from "./http/app.js";
export * from "./ids.js";
export * from "./logger.js";
export * from "./names.js";

const POOL_TICK_INTERVAL_MS = 60_000;

export function main(): void {
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
  registerLifecycle({
    coordinator,
    db,
    views,
    timers,
    registry,
    config: () => config,
    rng: Math.random,
    logger,
  });
  rearmTimers(db, timers, now);
  void coordinator.dispatch({ type: "PoolTick", payload: {} });
  const poolInterval = setInterval(() => {
    void coordinator.dispatch({ type: "PoolTick", payload: {} });
  }, POOL_TICK_INTERVAL_MS);
  poolInterval.unref();

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

  const server = serve({ fetch: app.fetch, port: loaded.env.PORT }, (info) => {
    logger.info({ port: info.port, rail: loaded.env.RAIL }, "listening");
  });

  const shutdown = () => {
    clearInterval(poolInterval);
    timers.disarmAll();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
