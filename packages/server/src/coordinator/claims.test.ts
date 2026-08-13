import { createRng } from "@onestepchess/core";
import { createMockRail } from "@onestepchess/rail-mock";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ServerConfig, serverConfigSchema } from "../config.js";
import { type OpenedDatabase, openDatabase, schema } from "../db/open.js";
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
  kind: "human" | "agent" = "human",
): Promise<void> {
  stack.database.sqlite
    .prepare(
      "INSERT INTO players(address, kind, nickname, created_at, banned) VALUES (?, ?, ?, ?, false)",
    )
    .run(address, kind, address, Date.now());
  await stack.coordinator.dispatch({ type: "PoolTick", payload: {} });
  await stack.coordinator.onIdle();
}

async function claim(
  stack: ReturnType<typeof setup>,
  address: string,
  demo = false,
  kind: "human" | "agent" = "human",
) {
  const result = await stack.coordinator.dispatch({
    type: "ClaimRequested",
    payload: { player: address, kind, demo },
    claimClass: kind,
  });
  if (result.kind !== "ok") throw new Error("claim deprioritized");
  return result.result as {
    claim: {
      id: string;
      gameId: string;
      stakeMicrousdc: number;
      deadline: number;
    } | null;
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

  it("leaves staked human claims unquoted while demo keeps exact rolling-window retry-after", async () => {
    const stack = setup({ GAME_POOL_TARGET: 2, QUOTA_DEMO: 1 });
    await player(stack, "alice");
    const first = await claim(stack, "alice");
    stack.database.sqlite
      .prepare("UPDATE claims SET deadline = ? WHERE id = ?")
      .run(Date.now(), first.claim?.id);
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: first.claim?.id },
    });
    const second = await claim(stack, "alice");
    expect(second.created).toBe(true);
    stack.database.sqlite
      .prepare("UPDATE claims SET deadline = ? WHERE id = ?")
      .run(Date.now(), second.claim?.id);
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: second.claim?.id },
    });

    const demo = await claim(stack, "alice", true);
    expect(demo.created).toBe(true);
    stack.database.sqlite
      .prepare("UPDATE claims SET deadline = ? WHERE id = ?")
      .run(Date.now(), demo.claim?.id);
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: demo.claim?.id },
    });
    const demoBlocked = await claim(stack, "alice", true);
    expect(demoBlocked).toMatchObject({
      claim: null,
      quota: true,
      retryAfterSeconds: 3600,
    });
  });

  it("quotaOverride still caps a specific human's staked claims", async () => {
    const stack = setup({ GAME_POOL_TARGET: 2 });
    await player(stack, "alice");
    stack.database.sqlite
      .prepare("UPDATE players SET quota_override = 1 WHERE address = ?")
      .run("alice");
    const first = await claim(stack, "alice");
    stack.database.sqlite
      .prepare("UPDATE claims SET deadline = ? WHERE id = ?")
      .run(Date.now(), first.claim?.id);
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: first.claim?.id },
    });
    const blocked = await claim(stack, "alice");
    expect(blocked).toMatchObject({
      claim: null,
      quota: true,
      retryAfterSeconds: 3600,
    });
  });

  it("agent_claim_terms_use_agent_and_endspiel_quota_ttl_and_stake", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 1,
      HUMAN_BOARD_RESERVE_PERCENT: 0,
      QUOTA_AGENT: 1,
      AGENT_STAKE: 1_234,
      ENDSPIEL_STAKE: 234,
      CLAIM_TTL_AGENT: 90,
      CLAIM_TTL_ENDSPIEL: 30,
    });
    await player(stack, "agent-normal", "agent");
    const normal = await claim(stack, "agent-normal", false, "agent");
    expect(normal.claim).toMatchObject({ stakeMicrousdc: 1_234 });
    expect(normal.claim?.deadline).toBe(Date.now() + 90_000);

    stack.database.db
      .update(schema.claims)
      .set({ deadline: Date.now() })
      .where(eq(schema.claims.id, normal.claim?.id as string))
      .run();
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: normal.claim?.id },
    });
    expect(await claim(stack, "agent-normal", false, "agent")).toMatchObject({
      claim: null,
      quota: true,
      retryAfterSeconds: 3_600,
    });

    await player(stack, "agent-end", "agent");
    stack.database.db
      .update(schema.games)
      .set({ status: "endspiel", endspielPly: 1 })
      .where(eq(schema.games.id, normal.claim?.gameId as string))
      .run();
    stack.views.rebuild(stack.database.db, Date.now());
    const endspiel = await claim(stack, "agent-end", false, "agent");
    expect(endspiel.claim).toMatchObject({ stakeMicrousdc: 234 });
    expect(endspiel.claim?.deadline).toBe(Date.now() + 30_000);
  });

  it("endspiel_excludes_humans_and_accepts_only_agents_after_threshold", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 1,
      CLAIM_TTL_ENDSPIEL: 30,
      ENDSPIEL_STAKE: 200,
    });
    await player(stack, "human");
    await player(stack, "agent-one", "agent");
    await player(stack, "agent-two", "agent");
    const game = [...stack.views.games.values()][0];
    if (game === undefined) throw new Error("game unavailable");
    stack.database.db
      .update(schema.games)
      .set({ status: "endspiel", endspielPly: 1 })
      .where(eq(schema.games.id, game.id))
      .run();
    stack.views.rebuild(stack.database.db, Date.now());

    expect((await claim(stack, "human")).claim).toBeNull();
    const first = await claim(stack, "agent-one", false, "agent");
    expect(first.claim).toMatchObject({ stakeMicrousdc: 200 });
    stack.database.db
      .update(schema.claims)
      .set({ deadline: Date.now() })
      .where(eq(schema.claims.id, first.claim?.id as string))
      .run();
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: first.claim?.id },
    });
    expect(
      (await claim(stack, "agent-two", false, "agent")).claim,
    ).toMatchObject({ stakeMicrousdc: 200 });
  });

  it("reserves the configured share of boards for humans while agents retry", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 4,
      HUMAN_BOARD_RESERVE_PERCENT: 25,
    });
    for (const address of ["agent-1", "agent-2", "agent-3", "agent-4"]) {
      await player(stack, address, "agent");
    }
    await player(stack, "human");

    for (const address of ["agent-1", "agent-2", "agent-3"]) {
      expect((await claim(stack, address, false, "agent")).created).toBe(true);
    }
    expect(await claim(stack, "agent-4", false, "agent")).toEqual({
      claim: null,
      created: false,
      retryAfterSeconds: 1,
    });
    expect((await claim(stack, "human")).created).toBe(true);
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
    const stack = setup({ GAME_POOL_TARGET: 4, POINTS_ENABLED: true });
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

  it("never credits a referral while POINTS_ENABLED is off (the default)", async () => {
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
    const game = stack.database.sqlite
      .prepare("SELECT id FROM games WHERE status = 'active'")
      .get() as { id: string } | undefined;
    if (game === undefined) throw new Error("expected an active pool game");
    stack.database.sqlite
      .prepare(
        "INSERT INTO claims(id, game_id, player, side, demo, stake_microusdc, status, created_at, deadline) VALUES ('clm_live_1', ?, 'referee', 'white', false, 1000, 'open', ?, ?)",
      )
      .run(game.id, now, now + 60_000);
    await stack.coordinator.dispatch({
      type: "MoveSettled",
      payload: {
        claimId: "clm_live_1",
        player: "referee",
        move: { uci: "e2e4", san: "e4" },
        clientTxid: "ct_tx_live_1",
        txid: "tx_live_1",
        response: "resp",
      },
    });

    expect(
      stack.database.sqlite
        .prepare("SELECT points, ref_qualified FROM players WHERE address = ?")
        .get("referrer"),
    ).toEqual({ points: 0, ref_qualified: 0 });
    expect(
      stack.database.sqlite
        .prepare("SELECT count(*) AS n FROM point_awards")
        .get(),
    ).toEqual({ n: 0 });
  });
});
