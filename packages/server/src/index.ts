import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
  applyConfigOverrides,
  ConfigError,
  type LoadedConfig,
  loadConfig,
  secretValues,
} from "./config.js";
import { openDatabase, schema } from "./db/open.js";
import { createApp } from "./http/app.js";
import { createLogger } from "./logger.js";

export * from "./config.js";
export * from "./db/open.js";
export * from "./http/app.js";
export * from "./logger.js";

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
  const { db } = openDatabase({ path: loaded.env.DB_PATH });
  const overrideRows = db
    .select({
      key: schema.configOverrides.key,
      valueJson: schema.configOverrides.valueJson,
    })
    .from(schema.configOverrides)
    .all();
  const config = applyConfigOverrides(loaded.config, overrideRows);
  logger.info(
    { dbPath: loaded.env.DB_PATH, overrides: overrideRows.length },
    "database ready",
  );
  void config;

  const app = createApp({
    logger,
    publicBaseUrl: loaded.env.PUBLIC_BASE_URL,
    mode: () => "running",
  });

  const server = serve({ fetch: app.fetch, port: loaded.env.PORT }, (info) => {
    logger.info({ port: info.port, rail: loaded.env.RAIL }, "listening");
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
