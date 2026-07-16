import type { Move } from "@onestepchess/core";
import { createRng } from "@onestepchess/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ServerConfig, serverConfigSchema } from "../config.js";
import { openDatabase, type OpenedDatabase } from "../db/open.js";
import { createLogger } from "../logger.js";
import { ChessAdapterRegistry } from "./chess-registry.js";
import { type LifecycleApi, registerLifecycle } from "./lifecycle.js";
import { Coordinator } from "./queue.js";
import { TimerService } from "./timers.js";
import { CoordinatorViews } from "./views.js";

const opened: OpenedDatabase[] = [];

type Stack = {
  database: OpenedDatabase;
  coordinator: Coordinator;
  views: CoordinatorViews;
  timers: TimerService;
  lifecycle: LifecycleApi;
  setConfig: (overrides: Record<string, unknown>) => void;
};

function setup(configOverrides: Record<string, unknown> = {}): Stack {
  const database = openDatabase({ path: ":memory:" });
  opened.push(database);
  let config: ServerConfig = serverConfigSchema.parse(configOverrides);
  const views = new CoordinatorViews();
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    now: () => Date.now(),
    views,
  });
  const timers = new TimerService({
    now: () => Date.now(),
    onFire: (kind, refId) => {
      void coordinator.dispatch({
        type: "TimerFired",
        payload: { kind, refId },
        refIds: [refId],
      });
    },
  });
  const registry = new ChessAdapterRegistry(8);
  const lifecycle = registerLifecycle({
    coordinator,
    db: database.db,
    views,
    timers,
    registry,
    config: () => config,
    rng: createRng(7),
    logger: createLogger({ level: "silent" }),
  });
  coordinator.register("CommitPly", (ctx, payload) =>
    lifecycle.applyCommittedPly(ctx, payload as { gameId: string; move: Move }),
  );
  return {
    database,
    coordinator,
    views,
    timers,
    lifecycle,
    setConfig: (overrides) => {
      config = serverConfigSchema.parse(overrides);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  for (const database of opened.splice(0)) {
    database.sqlite.close();
  }
});

async function poolTick(stack: Stack): Promise<void> {
  await stack.coordinator.dispatch({ type: "PoolTick", payload: {} });
  await stack.coordinator.onIdle();
}

function gameRow(stack: Stack, id: string) {
  return stack.database.sqlite
    .prepare(
      "SELECT status, ply, endspiel_ply, result, termination, finished_at, rules_json FROM games WHERE id = ?",
    )
    .get(id) as {
    status: string;
    ply: number;
    endspiel_ply: number | null;
    result: string | null;
    termination: string | null;
    finished_at: number | null;
    rules_json: string;
  };
}

function liveGameIds(stack: Stack): string[] {
  return stack.database.sqlite
    .prepare(
      "SELECT id FROM games WHERE status IN ('active','endspiel') ORDER BY id",
    )
    .all()
    .map((row) => (row as { id: string }).id);
}

async function commitPly(
  stack: Stack,
  gameId: string,
  input: string,
): Promise<unknown> {
  const game = stack.database.sqlite
    .prepare("SELECT history_json, rules_json FROM games WHERE id = ?")
    .get(gameId) as { history_json: string; rules_json: string };
  const registry = new ChessAdapterRegistry(2);
  const adapter = registry.get(JSON.parse(game.rules_json));
  const state = adapter.fromHistory(JSON.parse(game.history_json));
  const normalized = adapter.normalizeMove(state, input);
  if (!normalized.ok) throw new Error(`test move not legal: ${input}`);
  const result = await stack.coordinator.dispatch({
    type: "CommitPly",
    payload: { gameId, move: normalized.move },
  });
  await stack.coordinator.onIdle();
  return result.kind === "ok" ? result.result : result;
}

describe("pool top-up (F6)", () => {
  it("creates up to exactly the target counting active + endspiel", async () => {
    const stack = setup({ GAME_POOL_TARGET: 3 });
    await poolTick(stack);
    expect(liveGameIds(stack)).toHaveLength(3);
    expect(stack.views.games.size).toBe(3);

    // A second tick is a no-op.
    await poolTick(stack);
    expect(liveGameIds(stack)).toHaveLength(3);

    // Endspiel entry alone does not top up.
    const [first] = liveGameIds(stack) as [string];
    stack.database.sqlite
      .prepare("UPDATE games SET status = 'endspiel' WHERE id = ?")
      .run(first);
    stack.views.rebuild(stack.database.db, Date.now());
    await poolTick(stack);
    expect(liveGameIds(stack)).toHaveLength(3);
    expect(
      stack.database.sqlite.prepare("SELECT count(*) AS n FROM games").get(),
    ).toEqual({ n: 3 });

    // A terminal game is replaced.
    stack.database.sqlite
      .prepare("UPDATE games SET status = 'finished' WHERE id = ?")
      .run(first);
    stack.views.rebuild(stack.database.db, Date.now());
    await poolTick(stack);
    expect(liveGameIds(stack)).toHaveLength(3);
    expect(
      stack.database.sqlite.prepare("SELECT count(*) AS n FROM games").get(),
    ).toEqual({ n: 4 });
  });

  it("snapshots rules_json at creation; hot config edits never rewrite a live game", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1, ENDSPIEL_PLY: 60 });
    await poolTick(stack);
    const [gameId] = liveGameIds(stack) as [string];
    const before = JSON.parse(gameRow(stack, gameId).rules_json) as {
      ENDSPIEL_PLY: number;
    };
    expect(before.ENDSPIEL_PLY).toBe(60);

    stack.setConfig({ GAME_POOL_TARGET: 2, ENDSPIEL_PLY: 10 });
    await poolTick(stack);
    const after = JSON.parse(gameRow(stack, gameId).rules_json) as {
      ENDSPIEL_PLY: number;
    };
    expect(after.ENDSPIEL_PLY).toBe(60);

    const newGame = liveGameIds(stack).find((id) => id !== gameId) as string;
    expect(
      (JSON.parse(gameRow(stack, newGame).rules_json) as { ENDSPIEL_PLY: number })
        .ENDSPIEL_PLY,
    ).toBe(10);
  });

  it("generates unique word-list-shaped names", async () => {
    const stack = setup({ GAME_POOL_TARGET: 8 });
    await poolTick(stack);
    const names = stack.database.sqlite
      .prepare("SELECT name FROM games")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
    for (const name of names) {
      expect(name).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
    }
  });
});

describe("endspiel entry (F6)", () => {
  it("records endspiel at the exact triggering ply for the ply threshold", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 1,
      ENDSPIEL_PLY: 4,
      MAX_PLIES: 300,
    });
    await poolTick(stack);
    const [gameId] = liveGameIds(stack) as [string];

    for (const move of ["e2e4", "e7e5", "g1f3"]) {
      await commitPly(stack, gameId, move);
    }
    expect(gameRow(stack, gameId).status).toBe("active");

    await commitPly(stack, gameId, "b8c6");
    const row = gameRow(stack, gameId);
    expect(row.status).toBe("endspiel");
    expect(row.endspiel_ply).toBe(4);
  });

  it("records endspiel at the exact triggering ply for the piece threshold", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 1,
      ENDSPIEL_PLY: 100,
      ENDSPIEL_PIECES: 31,
      MAX_PLIES: 300,
    });
    await poolTick(stack);
    const [gameId] = liveGameIds(stack) as [string];

    await commitPly(stack, gameId, "e2e4");
    await commitPly(stack, gameId, "d7d5");
    expect(gameRow(stack, gameId).status).toBe("active");

    // First capture drops to 31 pieces.
    await commitPly(stack, gameId, "e4d5");
    const row = gameRow(stack, gameId);
    expect(row.status).toBe("endspiel");
    expect(row.endspiel_ply).toBe(3);
  });

  it("the endspiel ratchet is one-way", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1, ENDSPIEL_PLY: 2 });
    await poolTick(stack);
    const [gameId] = liveGameIds(stack) as [string];
    await commitPly(stack, gameId, "e2e4");
    await commitPly(stack, gameId, "e7e5");
    expect(gameRow(stack, gameId).status).toBe("endspiel");
    expect(gameRow(stack, gameId).endspiel_ply).toBe(2);

    await commitPly(stack, gameId, "g1f3");
    expect(gameRow(stack, gameId).status).toBe("endspiel");
    expect(gameRow(stack, gameId).endspiel_ply).toBe(2);
  });
});

describe("terminal detection (F6)", () => {
  it("checkmate sets result, termination and finished_at in the committing transaction", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1 });
    await poolTick(stack);
    const [gameId] = liveGameIds(stack) as [string];

    for (const move of ["f2f3", "e7e5", "g2g4"]) {
      await commitPly(stack, gameId, move);
    }
    await commitPly(stack, gameId, "d8h4");

    const row = gameRow(stack, gameId);
    expect(row.status).toBe("finished");
    expect(row.result).toBe("black");
    expect(row.termination).toBe("checkmate");
    expect(row.finished_at).toBe(Date.now());

    // Finish triggers a replacement top-up.
    expect(liveGameIds(stack)).toHaveLength(1);
    expect(liveGameIds(stack)[0]).not.toBe(gameId);
  });

  it("max-plies adjudicated draw terminates at the ply cap", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 1,
      ENDSPIEL_PLY: 4,
      MAX_PLIES: 4,
    });
    await poolTick(stack);
    const [gameId] = liveGameIds(stack) as [string];
    for (const move of ["e2e4", "e7e5", "g1f3"]) {
      await commitPly(stack, gameId, move);
    }
    expect(gameRow(stack, gameId).status).toBe("active");
    await commitPly(stack, gameId, "b8c6");
    const row = gameRow(stack, gameId);
    expect(row.status).toBe("finished");
    expect(row.result).toBe("draw");
    expect(row.termination).toBe("max_plies");
    expect(row.finished_at).toBe(Date.now());
  });
});

describe("stall abort (F6)", () => {
  it("aborts a stalled game and expires its open claim first (fake clock)", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1, STALL_ABORT_HOURS: 24 });
    await poolTick(stack);
    const [gameId] = liveGameIds(stack) as [string];

    stack.database.sqlite
      .prepare(
        "INSERT INTO players (address, kind, created_at) VALUES ('addr-a', 'human', 0)",
      )
      .run();
    stack.database.sqlite
      .prepare(
        `INSERT INTO claims (id, game_id, player, side, stake_microusdc, status, created_at, deadline)
         VALUES ('clm_1', ?, 'addr-a', 'white', 1000, 'open', ?, ?)`,
      )
      .run(gameId, Date.now(), Date.now() + 600_000);
    stack.views.rebuild(stack.database.db, Date.now());

    await vi.advanceTimersByTimeAsync(24 * 3_600_000 + 1);
    await stack.coordinator.onIdle();

    const row = gameRow(stack, gameId);
    expect(row.status).toBe("aborted");
    expect(row.result).toBe("aborted");
    expect(row.termination).toBe("aborted");
    expect(
      stack.database.sqlite
        .prepare("SELECT status FROM claims WHERE id = 'clm_1'")
        .get(),
    ).toEqual({ status: "expired" });

    // The claim was expired before the abort in the same command.
    const events = stack.database.sqlite
      .prepare("SELECT type FROM events ORDER BY id")
      .all()
      .map((row2) => (row2 as { type: string }).type);
    expect(events).toContain("claim_expired");

    // The aborted game is replaced by the pool.
    expect(liveGameIds(stack)).toHaveLength(1);
    expect(liveGameIds(stack)[0]).not.toBe(gameId);
  });
});

describe("chess adapter registry", () => {
  it("reuses adapter instances per rules key", () => {
    const registry = new ChessAdapterRegistry(4);
    const rulesA = serverConfigSchema.parse({});
    const rulesB = serverConfigSchema.parse({ ENDSPIEL_PLY: 10 });
    expect(registry.get(rulesA)).toBe(registry.get(rulesA));
    expect(registry.get(rulesA)).not.toBe(registry.get(rulesB));
    // Identical thresholds share the adapter even from distinct objects.
    expect(registry.get({ ...rulesA })).toBe(registry.get(rulesA));
  });
});
