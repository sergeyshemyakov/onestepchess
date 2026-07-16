import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRng } from "@onestepchess/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig, serverConfigSchema } from "./config.js";
import { ChessAdapterRegistry } from "./coordinator/chess-registry.js";
import { registerLifecycle } from "./coordinator/lifecycle.js";
import { Coordinator } from "./coordinator/queue.js";
import { TimerService } from "./coordinator/timers.js";
import { CoordinatorViews } from "./coordinator/views.js";
import { type OpenedDatabase, openDatabase, schema } from "./db/open.js";
import { createLogger } from "./logger.js";

const PLAYTEST_PATH = fileURLToPath(
  new URL("../../../osc.playtest.config.json", import.meta.url),
);
// The knobs the playtest overlay is allowed to touch (card #26); the default
// config that CI tests stays literally untouched.
const PLAYTEST_KNOBS = [
  "CLAIM_TTL_ENDSPIEL",
  "CLAIM_TTL_HUMAN",
  "GAME_POOL_TARGET",
  "MIN_PLY_INTERVAL_SECONDS",
] as const;

const databases: OpenedDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

describe("playtest profile config (#26)", () => {
  it("parses through the composed .strict() schema", () => {
    const loaded = loadConfig({ env: { OSC_CONFIG_PATH: PLAYTEST_PATH } });
    expect(loaded.configPath).toBe(PLAYTEST_PATH);
    expect(loaded.config.GAME_POOL_TARGET).toBe(1);
  });

  it("overrides only the documented playtest knobs", () => {
    const loaded = loadConfig({ env: { OSC_CONFIG_PATH: PLAYTEST_PATH } });
    const defaults = serverConfigSchema.parse({});
    const changed = Object.keys(defaults).filter(
      (key) =>
        (loaded.config as Record<string, unknown>)[key] !==
        (defaults as Record<string, unknown>)[key],
    );
    expect(changed.sort()).toEqual([...PLAYTEST_KNOBS].sort());
  });

  it("makes a game created under it carry its own rules_json snapshot", async () => {
    const config: ServerConfig = loadConfig({
      env: { OSC_CONFIG_PATH: PLAYTEST_PATH },
    }).config;
    const database = openDatabase({ path: ":memory:" });
    databases.push(database);
    const views = new CoordinatorViews();
    const coordinator = new Coordinator({
      sqlite: database.sqlite,
      db: database.db,
      logger: createLogger({ level: "silent" }),
      now: () => 1_000_000,
      views,
    });
    const timers = new TimerService({ now: () => 1_000_000, onFire: () => {} });
    registerLifecycle({
      coordinator,
      db: database.db,
      views,
      timers,
      registry: new ChessAdapterRegistry(4),
      config: () => config,
      rng: createRng(1),
      logger: createLogger({ level: "silent" }),
    });

    await coordinator.dispatch({ type: "PoolTick", payload: {} });

    const game = database.db.select().from(schema.games).get();
    expect(game).toBeDefined();
    const rules = JSON.parse(game?.rulesJson ?? "{}") as Record<string, number>;
    expect(rules.MIN_PLY_INTERVAL_SECONDS).toBe(3);
    expect(rules.CLAIM_TTL_HUMAN).toBe(120);
  });
});

describe("offline guarantee — RAIL=mock (#26)", () => {
  const bootSource = readFileSync(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
    "utf8",
  );

  it("constructs the mock rail in the boot path", () => {
    expect(bootSource).toContain("createMockRail(");
  });

  it("never imports rail-avm into the mock boot", () => {
    expect(bootSource).not.toContain("@onestepchess/rail-avm");
  });
});
