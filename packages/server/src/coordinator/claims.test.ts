import { createRng } from "@onestepchess/core";
import { createMockRail } from "@onestepchess/rail-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ServerConfig, serverConfigSchema } from "../config.js";
import { type OpenedDatabase, openDatabase } from "../db/open.js";
import { createLogger } from "../logger.js";
import { ChessAdapterRegistry } from "./chess-registry.js";
import { registerClaimCommands } from "./claims.js";
import { registerLifecycle } from "./lifecycle.js";
import { Coordinator } from "./queue.js";
import { registerResolution } from "./resolution.js";
import { TimerService } from "./timers.js";
import { CoordinatorViews } from "./views.js";

const databases: OpenedDatabase[] = [];

function setup(overrides: Record<string, unknown> = {}) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  let config: ServerConfig = serverConfigSchema.parse(overrides);
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
  const registry = new ChessAdapterRegistry(4);
  const lifecycle = registerLifecycle({
    coordinator,
    db: database.db,
    views,
    timers,
    registry,
    config: () => config,
    rng: createRng(4),
    logger: createLogger({ level: "silent" }),
  });
  registerClaimCommands({
    coordinator,
    db: database.db,
    views,
    timers,
    registry,
    lifecycle,
    config: () => config,
    rail: createMockRail(),
    now: Date.now,
    rng: createRng(9),
  });
  registerResolution({
    coordinator,
    db: database.db,
    logger: createLogger({ level: "silent" }),
  });
  return {
    database,
    coordinator,
    views,
    setConfig: (value: Record<string, unknown>) => {
      config = serverConfigSchema.parse(value);
    },
  };
}

async function player(
  stack: ReturnType<typeof setup>,
  address: string,
): Promise<void> {
  stack.database.sqlite
    .prepare(
      "INSERT INTO players(address, kind, nickname, created_at, banned) VALUES (?, 'human', ?, ?, false)",
    )
    .run(address, address, Date.now());
  await stack.coordinator.dispatch({ type: "PoolTick", payload: {} });
  await stack.coordinator.onIdle();
}

async function claim(
  stack: ReturnType<typeof setup>,
  address: string,
  demo = false,
) {
  const result = await stack.coordinator.dispatch({
    type: "ClaimRequested",
    payload: { player: address, kind: "human" as const, demo },
    claimClass: "human",
  });
  if (result.kind !== "ok") throw new Error("claim deprioritized");
  return result.result as {
    claim: { id: string; gameId: string } | null;
    created: boolean;
    quota?: boolean;
    retryAfterSeconds?: number;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.sqlite.close();
});

describe("claim issuance (F3/F5)", () => {
  it("persists the exact board position presented by the claim", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1 });
    await player(stack, "alice");
    const game = [...stack.views.games.values()][0];
    if (game === undefined) throw new Error("game unavailable");
    const positionAfterE4 =
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    game.fen = positionAfterE4;
    game.ply = 1;
    stack.database.sqlite
      .prepare("UPDATE games SET fen = ?, ply = 1 WHERE id = ?")
      .run(positionAfterE4, game.id);

    const opened = await claim(stack, "alice");

    expect(
      stack.database.sqlite
        .prepare("SELECT fen_before FROM claims WHERE id = ?")
        .get(opened.claim?.id),
    ).toEqual({ fen_before: positionAfterE4 });
  });

  it("get-or-create returns the same open claim even when demo changes", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1 });
    await player(stack, "alice");
    const first = await claim(stack, "alice");
    const again = await claim(stack, "alice", true);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.claim?.id).toBe(first.claim?.id);
  });

  it("serializes concurrent requests into at most one open claim", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1 });
    await player(stack, "alice");
    const [left, right] = await Promise.all([
      claim(stack, "alice"),
      claim(stack, "alice"),
    ]);
    expect(left.claim?.id).toBe(right.claim?.id);
    expect(
      stack.database.sqlite
        .prepare("SELECT count(*) AS n FROM claims WHERE status = 'open'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("uses independent demo quota and exact rolling-window retry-after", async () => {
    const stack = setup({ GAME_POOL_TARGET: 2, QUOTA_HUMAN: 1, QUOTA_DEMO: 1 });
    await player(stack, "alice");
    const first = await claim(stack, "alice");
    stack.database.sqlite
      .prepare("UPDATE claims SET deadline = ? WHERE id = ?")
      .run(Date.now(), first.claim?.id);
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: first.claim?.id },
    });
    const blocked = await claim(stack, "alice");
    const demo = await claim(stack, "alice", true);
    expect(blocked).toMatchObject({
      claim: null,
      quota: true,
      retryAfterSeconds: 3600,
    });
    expect(demo.created).toBe(true);
  });

  it("expires a claim, frees the slot, and defers while an intent is in flight", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1, CLAIM_TTL_HUMAN: 1 });
    await player(stack, "alice");
    await player(stack, "bob");
    const opened = await claim(stack, "alice");
    const id = opened.claim?.id as string;
    stack.database.sqlite
      .prepare(
        "INSERT INTO payment_intents(id, claim_id, player, move_uci, amount, client_txid, status, created_at, updated_at) VALUES ('pi_1', ?, 'alice', 'e2e4', 1, 'tx_1', 'settling', ?, ?)",
      )
      .run(id, Date.now(), Date.now());
    vi.advanceTimersByTime(1_000);
    await stack.coordinator.onIdle();
    expect(
      stack.database.sqlite
        .prepare("SELECT status FROM claims WHERE id = ?")
        .get(id),
    ).toEqual({ status: "open" });
    stack.database.sqlite
      .prepare("UPDATE payment_intents SET status = 'failed' WHERE id = 'pi_1'")
      .run();
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: id },
    });
    expect(
      stack.database.sqlite
        .prepare("SELECT status FROM claims WHERE id = ?")
        .get(id),
    ).toEqual({ status: "expired" });
    expect((await claim(stack, "bob")).created).toBe(true);
  });

  it("uses the latest participation ply when enforcing cooldown", async () => {
    const stack = setup({ GAME_POOL_TARGET: 1, COOLDOWN_PLIES: 6 });
    await player(stack, "alice");
    const game = [...stack.views.games.values()][0];
    if (game === undefined) throw new Error("game unavailable");
    stack.database.sqlite
      .prepare(
        `INSERT INTO claims(id, game_id, player, side, demo, stake_microusdc, status, created_at, deadline, moved_ply)
         VALUES (?, ?, 'alice', 'white', false, 1000, 'moved', ?, ?, ?)`,
      )
      .run("clm_old", game.id, Date.now() - 2, Date.now() - 1, 1);
    stack.database.sqlite
      .prepare(
        `INSERT INTO claims(id, game_id, player, side, demo, stake_microusdc, status, created_at, deadline, moved_ply)
         VALUES (?, ?, 'alice', 'white', false, 1000, 'moved', ?, ?, ?)`,
      )
      .run("clm_latest", game.id, Date.now() - 1, Date.now(), 7);
    stack.database.sqlite
      .prepare(
        `INSERT INTO stake_entries(id, game_id, claim_id, player, side, kind, amount, pay_txid, ply, created_at)
         VALUES (?, ?, ?, 'alice', 'white', 'human', 1000, ?, ?, ?)`,
      )
      .run("se_old", game.id, "clm_old", "tx_old", 1, Date.now() - 2);
    stack.database.sqlite
      .prepare(
        `INSERT INTO stake_entries(id, game_id, claim_id, player, side, kind, amount, pay_txid, ply, created_at)
         VALUES (?, ?, ?, 'alice', 'white', 'human', 1000, ?, ?, ?)`,
      )
      .run("se_latest", game.id, "clm_latest", "tx_latest", 7, Date.now() - 1);
    stack.database.sqlite
      .prepare("UPDATE games SET ply = 8 WHERE id = ?")
      .run(game.id);
    game.ply = 8;

    expect((await claim(stack, "alice")).claim).toBeNull();
  });
});

describe("referral award through the settled move path (F15 step 4)", () => {
  it("credits the referrer once when the referred human's qualifying move settles", async () => {
    const stack = setup({ GAME_POOL_TARGET: 4 });
    const now = Date.now();
    stack.database.sqlite
      .prepare(
        "INSERT INTO players(address, kind, nickname, created_at, banned) VALUES ('referrer', 'human', 'referrer', ?, false)",
      )
      .run(now);
    stack.database.sqlite
      .prepare(
        "INSERT INTO players(address, kind, nickname, created_at, banned, referred_by) VALUES ('referee', 'human', 'referee', ?, false, 'referrer')",
      )
      .run(now);
    await stack.coordinator.dispatch({ type: "PoolTick", payload: {} });
    await stack.coordinator.onIdle();

    // Two qualifying staked moves already banked in a prior finished game.
    stack.database.sqlite
      .prepare(
        "INSERT INTO games(id, name, status, fen, rules_json, ply, last_ply_at, created_at, result, finished_at) VALUES ('gm_prior', 'prior', 'finished', 'fen', '{}', 2, ?, ?, 'white', ?)",
      )
      .run(now, now, now);
    for (const n of [1, 2]) {
      stack.database.sqlite
        .prepare(
          "INSERT INTO claims(id, game_id, player, side, demo, stake_microusdc, status, created_at, deadline, moved_ply) VALUES (?, 'gm_prior', 'referee', 'white', false, 1000, 'moved', ?, ?, ?)",
        )
        .run(`clm_prior_${n}`, now, now, n);
      stack.database.sqlite
        .prepare(
          "INSERT INTO stake_entries(id, game_id, claim_id, player, side, kind, amount, pay_txid, ply, created_at) VALUES (?, 'gm_prior', ?, 'referee', 'white', 'human', 1000, ?, ?, ?)",
        )
        .run(`se_prior_${n}`, `clm_prior_${n}`, `tx_prior_${n}`, n, now);
    }

    const settleMove = async (
      claimId: string,
      gameId: string,
      txid: string,
    ) => {
      stack.database.sqlite
        .prepare(
          "INSERT INTO claims(id, game_id, player, side, demo, stake_microusdc, status, created_at, deadline) VALUES (?, ?, 'referee', 'white', false, 1000, 'open', ?, ?)",
        )
        .run(claimId, gameId, now, now + 60_000);
      await stack.coordinator.dispatch({
        type: "MoveSettled",
        payload: {
          claimId,
          player: "referee",
          move: { uci: "e2e4", san: "e4" },
          clientTxid: `ct_${txid}`,
          txid,
          response: "resp",
        },
      });
    };
    const activeGames = stack.database.sqlite
      .prepare("SELECT id FROM games WHERE status = 'active'")
      .all() as { id: string }[];
    const [first, second] = activeGames;
    if (first === undefined || second === undefined)
      throw new Error("expected active pool games");

    // The qualifying (3rd) staked move fires exactly one referral award.
    await settleMove("clm_live_1", first.id, "tx_live_1");
    const referrer = () =>
      stack.database.sqlite
        .prepare("SELECT points, ref_qualified FROM players WHERE address = ?")
        .get("referrer") as { points: number; ref_qualified: number };
    expect(referrer()).toEqual({ points: 50, ref_qualified: 1 });
    expect(
      stack.database.sqlite
        .prepare("SELECT referral_awarded_at FROM players WHERE address = ?")
        .get("referee"),
    ).not.toEqual({ referral_awarded_at: null });

    // A later staked move never re-awards.
    await settleMove("clm_live_2", second.id, "tx_live_2");
    expect(referrer()).toEqual({ points: 50, ref_qualified: 1 });
    expect(
      stack.database.sqlite
        .prepare(
          "SELECT count(*) AS n FROM point_awards WHERE reason = 'referral'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
});
