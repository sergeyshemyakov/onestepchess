import { STARTING_FEN } from "@onestepchess/core";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../../auth/jwt.js";
import { CardCache } from "../../cards/raster.js";
import { buildCardSvg } from "../../cards/svg.js";
import { serverConfigSchema } from "../../config.js";
import { Coordinator } from "../../coordinator/queue.js";
import { registerResolution } from "../../coordinator/resolution.js";
import { CoordinatorViews } from "../../coordinator/views.js";
import {
  type Db,
  type OpenedDatabase,
  openDatabase,
  schema,
} from "../../db/open.js";
import { createLogger } from "../../logger.js";
import { createApp } from "../app.js";
import { registerHumanCommands, registerHumanRoutes } from "./human.js";

const BASE_URL = "https://osc.example";
const JWT_SECRET = "human-test-secret-that-is-long-enough";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FEN_AFTER_E4 =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const FEN_AFTER_E5 =
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e5 0 2";
const databases: OpenedDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
});

function setup(overrides: Record<string, unknown> = {}) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  const config = serverConfigSchema.parse(overrides);
  let now = 10_000_000;
  const views = new CoordinatorViews();
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    now: () => now,
    views,
  });
  registerResolution({
    coordinator,
    db: database.db,
    logger: createLogger({ level: "silent" }),
  });
  const balanceCalls: string[] = [];
  const rail = {
    getBalances: async (address: string) => {
      balanceCalls.push(address);
      return { usdcMicroUsdc: 123_000, algoMicroAlgo: 456_000 };
    },
  };
  const deps = {
    db: database.db,
    coordinator,
    // Only the balance probe reaches the rail from these routes; the stub
    // keeps the "no chain read on the boot probe" assertion airtight.
    rail: rail as never,
    config: () => config,
    jwtSecret: JWT_SECRET,
    publicBaseUrl: BASE_URL,
    trustProxyHops: 0,
    now: () => now,
    rng: () => 0.42,
  };
  registerHumanCommands(deps);
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl: BASE_URL,
    mode: () => "running",
  });
  registerHumanRoutes(app, deps);
  return {
    app,
    db: database.db,
    coordinator,
    balanceCalls,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}

type Stack = ReturnType<typeof setup>;

function bearer(stack: Stack, address: string): Record<string, string> {
  return {
    authorization: `Bearer ${signSession(JWT_SECRET, {
      sub: address,
      kind: "human",
      jti: `jti-${address}`,
      iat: Math.floor(stack.now() / 1_000),
      exp: Math.floor(stack.now() / 1_000) + 3_600,
    })}`,
  };
}

function seedPlayer(db: Db, address: string, nickname: string | null): void {
  db.insert(schema.players)
    .values({ address, kind: "human", nickname, createdAt: 0 })
    .run();
}

let seedCounter = 0;

type SeedMove = {
  readonly player: string;
  readonly side: "white" | "black";
  readonly demo: boolean;
  readonly stake: number;
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly fenAfter: string;
  readonly status?: "moved" | "expired" | "open";
};

function seedGame(
  db: Db,
  args: {
    readonly id: string;
    readonly name: string;
    readonly status: "active" | "finished" | "aborted";
    readonly result?: "white" | "black" | "draw" | "aborted";
    readonly termination?: "checkmate" | "stalemate" | "threefold" | "aborted";
    readonly rules?: Readonly<Record<string, unknown>>;
    readonly history?: readonly string[];
    readonly finishedAt?: number;
    readonly createdAt?: number;
    readonly moves: readonly SeedMove[];
  },
): Map<string, string> {
  db.insert(schema.games)
    .values({
      id: args.id,
      name: args.name,
      status: args.status,
      fen: args.moves.at(-1)?.fenAfter ?? STARTING_FEN,
      historyJson: JSON.stringify(args.history ?? []),
      rulesJson: JSON.stringify(args.rules ?? {}),
      result: args.result ?? null,
      termination: args.termination ?? null,
      lastPlyAt: args.createdAt ?? 0,
      createdAt: args.createdAt ?? 0,
      finishedAt: args.finishedAt ?? null,
    })
    .run();
  const claimIds = new Map<string, string>();
  let fenBefore = STARTING_FEN;
  for (const move of args.moves) {
    seedCounter += 1;
    const claimId = `clm_h_${seedCounter}`;
    claimIds.set(`${move.player}:${move.ply}`, claimId);
    const status = move.status ?? "moved";
    db.insert(schema.claims)
      .values({
        id: claimId,
        gameId: args.id,
        player: move.player,
        side: move.side,
        demo: move.demo,
        stakeMicrousdc: move.stake,
        status,
        createdAt: (args.createdAt ?? 0) + move.ply,
        deadline: (args.createdAt ?? 0) + move.ply + 600_000,
        fenBefore,
        ...(status === "moved"
          ? {
              movedAt: (args.createdAt ?? 0) + move.ply + 1,
              movedPly: move.ply,
              moveUci: move.uci,
              moveSan: move.san,
              fenAfter: move.fenAfter,
            }
          : {}),
      })
      .run();
    if (status === "moved") fenBefore = move.fenAfter;
    if (!move.demo && status === "moved") {
      db.insert(schema.stakeEntries)
        .values({
          id: `se_h_${seedCounter}`,
          gameId: args.id,
          claimId,
          player: move.player,
          side: move.side,
          kind: "human",
          amount: move.stake,
          payTxid: `ptx_${claimId}`,
          ply: move.ply,
          createdAt: (args.createdAt ?? 0) + move.ply + 1,
        })
        .run();
    }
  }
  return claimIds;
}

async function finish(stack: Stack, gameId: string): Promise<unknown> {
  const result = await stack.coordinator.dispatch({
    type: "GameFinished",
    payload: { gameId },
    refIds: [gameId],
  });
  if (result.kind !== "ok") throw new Error("resolution deprioritized");
  return result.result;
}

function staked(
  player: string,
  side: "white" | "black",
  ply: number,
  fenAfter = FEN_AFTER_E4,
): SeedMove {
  return {
    player,
    side,
    demo: false,
    stake: 1_000,
    ply,
    uci: side === "white" ? "e2e4" : "e7e5",
    san: side === "white" ? "e4" : "e5",
    fenAfter,
  };
}

describe("profile, game history, and public replay reads (§6.3)", () => {
  it("active_archive_pages_contain_five_animated_games", async () => {
    const stack = setup();
    seedPlayer(stack.db, "alice", "alice");
    for (let index = 1; index <= 6; index += 1) {
      seedGame(stack.db, {
        id: `gm_active_${index}`,
        name: `active-${index}`,
        status: "active",
        createdAt: index * 1_000,
        moves: [staked("alice", "white", 1)],
      });
    }

    const response = await stack.app.request(
      "/api/v1/my/games?status=ongoing&page=1",
      { headers: bearer(stack, "alice") },
    );
    const page = (await response.json()) as {
      items: unknown[];
      page: number;
      pageCount: number;
      total: number;
    };

    expect(response.status).toBe(200);
    expect(page).toMatchObject({ page: 1, pageCount: 2, total: 6 });
    expect(page.items).toHaveLength(5);
  });

  it("profile_carries_points_and_referrals_for_humans_only", async () => {
    const stack = setup();
    stack.db
      .insert(schema.players)
      .values({
        address: "alice",
        kind: "human",
        nickname: "alice",
        createdAt: 0,
        points: 120,
        refCode: "gentle-rook-042",
        refJoined: 2,
        refQualified: 1,
      })
      .run();
    stack.db
      .insert(schema.players)
      .values({
        address: "botzilla",
        kind: "agent",
        nickname: "botzilla",
        createdAt: 0,
        points: 999,
      })
      .run();

    const human = (await (
      await stack.app.request("/api/v1/my/profile", {
        headers: bearer(stack, "alice"),
      })
    ).json()) as Record<string, unknown>;
    expect(human.points).toBe(120);
    expect(human.refCode).toBe("gentle-rook-042");
    expect(human.referrals).toEqual({ joined: 2, qualified: 1 });

    const agentBearer = {
      authorization: `Bearer ${signSession(JWT_SECRET, {
        sub: "botzilla",
        kind: "agent",
        jti: "jti-bot",
        iat: Math.floor(stack.now() / 1_000),
        exp: Math.floor(stack.now() / 1_000) + 3_600,
      })}`,
    };
    const agent = (await (
      await stack.app.request("/api/v1/my/profile", { headers: agentBearer })
    ).json()) as Record<string, unknown>;
    // Points/referral fields are humans-only (F14/F15) — absent for agents.
    expect(agent).not.toHaveProperty("points");
    expect(agent).not.toHaveProperty("refCode");
    expect(agent).not.toHaveProperty("referrals");
  });

  it("profile_boot_probe_never_reads_chain_balances", async () => {
    const stack = setup();
    seedPlayer(stack.db, "alice", "alice");

    const plain = await stack.app.request("/api/v1/my/profile", {
      headers: bearer(stack, "alice"),
    });
    expect(plain.status).toBe(200);
    expect((await plain.json()) as object).not.toHaveProperty("balances");
    expect(stack.balanceCalls).toHaveLength(0);

    const withBalances = await stack.app.request(
      "/api/v1/my/profile?include=balances",
      { headers: bearer(stack, "alice") },
    );
    expect(withBalances.status).toBe(200);
    expect(
      ((await withBalances.json()) as { balances: unknown }).balances,
    ).toEqual({ usdcMicroUsdc: 123_000, algoMicroAlgo: 456_000 });
    expect(stack.balanceCalls).toEqual(["alice"]);

    const invalid = await stack.app.request(
      "/api/v1/my/profile?include=everything",
      { headers: bearer(stack, "alice") },
    );
    expect(invalid.status).toBe(400);
    expect(stack.balanceCalls).toHaveLength(1);
  });

  it("profile_quotas_and_stats_match_rolling_history", async () => {
    const stack = setup({ QUOTA_DEMO: 1 });
    seedPlayer(stack.db, "alice", "alice");
    seedPlayer(stack.db, "bob", "bob");

    // Seeded well outside the rolling hour so quota reads stay isolated.
    seedGame(stack.db, {
      id: "gm_win",
      name: "win-game",
      status: "finished",
      result: "white",
      termination: "checkmate",
      finishedAt: 1_000,
      moves: [staked("alice", "white", 1), staked("bob", "black", 2)],
    });
    seedGame(stack.db, {
      id: "gm_abort",
      name: "abort-game",
      status: "aborted",
      result: "aborted",
      termination: "aborted",
      finishedAt: 2_000,
      moves: [staked("alice", "white", 1), staked("bob", "black", 2)],
    });
    seedGame(stack.db, {
      id: "gm_demo",
      name: "demo-game",
      status: "finished",
      result: "black",
      termination: "checkmate",
      finishedAt: 3_000,
      moves: [
        {
          player: "alice",
          side: "black",
          demo: true,
          stake: 0,
          ply: 1,
          uci: "e2e4",
          san: "e4",
          fenAfter: FEN_AFTER_E4,
        },
      ],
    });
    await finish(stack, "gm_win");
    await finish(stack, "gm_abort");
    await finish(stack, "gm_demo");

    // Realized PnL is fixed at resolution while every payout is still queued.
    const jobs = stack.db.select().from(schema.payoutJobs).all();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.status === "pending")).toBe(true);

    const profile = (await (
      await stack.app.request("/api/v1/my/profile", {
        headers: bearer(stack, "alice"),
      })
    ).json()) as {
      stats: Record<string, unknown>;
      netPnlMicroUsdc: number;
      quotas: {
        staked: { limit: number; remaining: number; resetsAt: string | null };
        demo: { limit: number; remaining: number; resetsAt: string | null };
      };
    };
    // Demo result excluded; the abort is recorded as a draw but does not lower
    // winrate. Winner takes stake + capped loser pot (1000 + 1000).
    expect(profile.stats).toEqual({
      moves: 2,
      wins: 1,
      draws: 1,
      losses: 0,
      winratePct: 100,
    });
    expect(profile.netPnlMicroUsdc).toBe(1_000);

    const bobProfile = (await (
      await stack.app.request("/api/v1/my/profile", {
        headers: bearer(stack, "bob"),
      })
    ).json()) as { stats: Record<string, unknown>; netPnlMicroUsdc: number };
    expect(bobProfile.stats).toMatchObject({
      wins: 0,
      draws: 1,
      losses: 1,
      winratePct: 0,
    });
    expect(bobProfile.netPnlMicroUsdc).toBe(-1_000);

    // Rolling windows: one staked and one demo claim created 30 minutes ago.
    const claimStart = stack.now() - HOUR_MS / 2;
    stack.db
      .insert(schema.claims)
      .values([
        {
          id: "clm_q_staked",
          gameId: "gm_win",
          player: "alice",
          side: "white",
          demo: false,
          stakeMicrousdc: 1_000,
          status: "expired",
          createdAt: claimStart,
          deadline: claimStart + 600_000,
        },
        {
          id: "clm_q_demo",
          gameId: "gm_win",
          player: "alice",
          side: "white",
          demo: true,
          stakeMicrousdc: 0,
          status: "expired",
          createdAt: claimStart,
          deadline: claimStart + 600_000,
        },
      ])
      .run();
    const inWindow = (await (
      await stack.app.request("/api/v1/my/profile", {
        headers: bearer(stack, "alice"),
      })
    ).json()) as typeof profile;
    const resetsAt = new Date(claimStart + HOUR_MS).toISOString();
    // Staked human claims are uncapped — the profile reports a null window.
    expect(inWindow.quotas.staked).toEqual({
      limit: null,
      remaining: null,
      resetsAt: null,
    });
    expect(inWindow.quotas.demo).toEqual({ limit: 1, remaining: 0, resetsAt });

    stack.setNow(claimStart + HOUR_MS + 1_000);
    const afterWindow = (await (
      await stack.app.request("/api/v1/my/profile", {
        headers: bearer(stack, "alice"),
      })
    ).json()) as typeof profile;
    expect(afterWindow.quotas.staked).toEqual({
      limit: null,
      remaining: null,
      resetsAt: null,
    });
    expect(afterWindow.quotas.demo).toEqual({
      limit: 1,
      remaining: 1,
      resetsAt: null,
    });

    seedPlayer(stack.db, "carol", "carol");
    const fresh = (await (
      await stack.app.request("/api/v1/my/profile", {
        headers: bearer(stack, "carol"),
      })
    ).json()) as { stats: { winratePct: number | null } };
    expect(fresh.stats.winratePct).toBeNull();
  });

  it("nickname_changes_enforce_validation_collision_and_rolling_limit", async () => {
    const stack = setup({ NICKNAME_CHANGES_PER_DAY: 2 });
    seedPlayer(stack.db, "alice", "alice-original");
    seedPlayer(stack.db, "bob", "taken-nick");
    const patch = (nickname: unknown) =>
      stack.app.request("/api/v1/my/profile", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...bearer(stack, "alice"),
        },
        body: JSON.stringify({ nickname }),
      });

    const invalid = await patch("x!");
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toBe(
      "INVALID_NICKNAME",
    );

    // Collisions are case-insensitive and come with a free suggestion.
    const taken = await patch("TAKEN-NICK");
    expect(taken.status).toBe(409);
    const takenBody = (await taken.json()) as {
      error: string;
      suggestion: string;
    };
    expect(takenBody.error).toBe("NICKNAME_TAKEN");
    expect(takenBody.suggestion).toMatch(/^[a-zA-Z0-9_-]{3,24}$/);

    const firstAt = stack.now();
    const first = await patch("fresh-one");
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as { player: { nickname: string } }).player
        .nickname,
    ).toBe("fresh-one");
    stack.setNow(firstAt + 1_000);
    expect((await patch("fresh-two")).status).toBe(200);

    stack.setNow(firstAt + 2_000);
    const limited = await patch("fresh-three");
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe(
      "RENAME_RATE_LIMITED",
    );
    // Exactly until the oldest in-window change ages out (rolling 24 h).
    expect(limited.headers.get("Retry-After")).toBe(
      String(Math.ceil((firstAt + DAY_MS - stack.now()) / 1_000)),
    );
    expect(stack.db.select().from(schema.nicknameChanges).all()).toHaveLength(
      2,
    );

    stack.setNow(firstAt + DAY_MS + 1_000);
    expect((await patch("fresh-three")).status).toBe(200);
  });

  it("my_games_groups_finished_moves_by_game_and_aggregates_card_totals", async () => {
    const stack = setup({ PAGE_SIZE_FINISHED: 2 });
    seedPlayer(stack.db, "alice", "alice");
    seedPlayer(stack.db, "bob", "bob");

    seedGame(stack.db, {
      id: "gm_ongoing_staked",
      name: "ongoing-staked",
      status: "active",
      createdAt: 1_000,
      moves: [staked("alice", "white", 1)],
    });
    seedGame(stack.db, {
      id: "gm_ongoing_demo",
      name: "ongoing-demo",
      status: "active",
      createdAt: 2_000,
      moves: [
        {
          player: "alice",
          side: "white",
          demo: true,
          stake: 0,
          ply: 1,
          uci: "e2e4",
          san: "e4",
          fenAfter: FEN_AFTER_E4,
        },
      ],
    });
    seedGame(stack.db, {
      id: "gm_expired",
      name: "expired-claim-game",
      status: "active",
      createdAt: 3_000,
      moves: [{ ...staked("alice", "white", 1), status: "expired" }],
    });

    const ongoing = (await (
      await stack.app.request("/api/v1/my/games?status=ongoing", {
        headers: bearer(stack, "alice"),
      })
    ).json()) as {
      items: Record<string, unknown>[];
      total: number;
    };
    // The expired claim never appears; ongoing cards are position-only.
    expect(ongoing.total).toBe(2);
    const ongoingDemo = ongoing.items.find((item) => item.demo === true);
    const ongoingStaked = ongoing.items.find((item) => item.demo === false);
    if (ongoingDemo === undefined || ongoingStaked === undefined)
      throw new Error("ongoing cards missing");
    for (const card of [ongoingDemo, ongoingStaked]) {
      expect(Object.keys(card).sort()).toEqual([
        "claimedAt",
        "demo",
        "fenBeforeYourMove",
        "movedAt",
        "payTxid",
        "stakeMicroUsdc",
        "yourMove",
        "yourSide",
      ]);
      expect(card.fenBeforeYourMove).toBe(STARTING_FEN);
    }
    expect(ongoingStaked.payTxid).toMatch(/^ptx_/);
    expect(ongoingDemo.payTxid).toBeNull();

    seedGame(stack.db, {
      id: "gm_fin_win",
      name: "finished-win",
      status: "finished",
      result: "white",
      termination: "checkmate",
      finishedAt: 5_000,
      createdAt: 4_000,
      moves: [staked("alice", "white", 1), staked("bob", "black", 2)],
    });
    seedGame(stack.db, {
      id: "gm_fin_loss",
      name: "finished-loss",
      status: "finished",
      result: "black",
      termination: "checkmate",
      finishedAt: 6_000,
      createdAt: 4_000,
      moves: [
        staked("alice", "white", 1),
        staked("bob", "black", 2, FEN_AFTER_E5),
        {
          ...staked("alice", "white", 3),
          uci: "g1f3",
          san: "Nf3",
        },
      ],
    });
    seedGame(stack.db, {
      id: "gm_fin_demo",
      name: "finished-demo",
      status: "finished",
      result: "draw",
      termination: "stalemate",
      finishedAt: 7_000,
      createdAt: 4_000,
      moves: [
        {
          player: "alice",
          side: "white",
          demo: true,
          stake: 0,
          ply: 1,
          uci: "e2e4",
          san: "e4",
          fenAfter: FEN_AFTER_E4,
        },
      ],
    });
    await finish(stack, "gm_fin_win");
    await finish(stack, "gm_fin_loss");
    await finish(stack, "gm_fin_demo");

    const pageOne = (await (
      await stack.app.request("/api/v1/my/games?status=finished", {
        headers: bearer(stack, "alice"),
      })
    ).json()) as {
      items: Record<string, unknown>[];
      page: number;
      pageCount: number;
      total: number;
    };
    expect(pageOne).toMatchObject({ page: 1, pageCount: 2, total: 3 });
    expect(pageOne.items.map((item) => item.demo)).toEqual([true, false]);

    const demoCard = pageOne.items[0] as Record<string, unknown>;
    expect(Object.keys(demoCard).sort()).toEqual([
      "demo",
      "finishedAt",
      "payoutMicroUsdc",
      "payoutStatus",
      "repetitionAdjudication",
      "result",
      "stakeMicroUsdc",
      "startedAt",
      "statsCounted",
      "termination",
      "thinkingTimeMs",
      "yourMoves",
      "yourSide",
    ]);
    expect(demoCard).toMatchObject({
      result: "draw",
      termination: "stalemate",
      yourMoves: [{ uci: "e2e4", san: "e4" }],
      thinkingTimeMs: 1,
      payoutMicroUsdc: 0,
      payoutStatus: null,
      statsCounted: false,
    });
    // No identifier or fingerprint reaches the demo card.
    const demoJson = JSON.stringify(demoCard);
    expect(demoJson).not.toContain("gm_fin_demo");
    expect(demoJson).not.toContain("finished-demo");
    expect(demoJson).not.toContain(FEN_AFTER_E4);

    const lossCard = pageOne.items[1] as Record<string, unknown>;
    expect(Object.keys(lossCard).sort()).toEqual([
      "demo",
      "finalFen",
      "finishedAt",
      "gameId",
      "gameName",
      "payTxid",
      "payoutMicroUsdc",
      "payoutStatus",
      "payoutTxid",
      "repetitionAdjudication",
      "result",
      "stakeMicroUsdc",
      "startedAt",
      "statsCounted",
      "termination",
      "thinkingTimeMs",
      "yourMoves",
      "yourSide",
    ]);
    expect(lossCard).toMatchObject({
      gameId: "gm_fin_loss",
      gameName: "finished-loss",
      result: "black",
      startedAt: new Date(4_000).toISOString(),
      finishedAt: new Date(6_000).toISOString(),
      yourMoves: [
        { uci: "e2e4", san: "e4", ply: 1 },
        { uci: "g1f3", san: "Nf3", ply: 3 },
      ],
      stakeMicroUsdc: 2_000,
      thinkingTimeMs: 2,
      payTxid: null,
      payoutMicroUsdc: 0,
      payoutStatus: "none",
      payoutTxid: null,
      statsCounted: true,
    });

    const pageTwo = (await (
      await stack.app.request("/api/v1/my/games?status=finished&page=2", {
        headers: bearer(stack, "alice"),
      })
    ).json()) as { items: Record<string, unknown>[]; page: number };
    expect(pageTwo.page).toBe(2);
    expect(pageTwo.items).toHaveLength(1);
    expect(pageTwo.items[0]).toMatchObject({
      gameId: "gm_fin_win",
      yourMoves: [{ uci: "e2e4", san: "e4", ply: 1 }],
      stakeMicroUsdc: 1_000,
      thinkingTimeMs: 1,
      payTxid: expect.stringMatching(/^ptx_/),
      payoutMicroUsdc: 2_000,
      payoutStatus: "queued",
    });
  });

  it("resolution_materializes_replay_and_counters_once", async () => {
    const stack = setup();
    seedPlayer(stack.db, "alice", "alice");
    seedPlayer(stack.db, "bob", "bob");
    seedGame(stack.db, {
      id: "gm_once",
      name: "resolve-once",
      status: "finished",
      result: "white",
      termination: "checkmate",
      history: ["e2e4", "e7e5"],
      finishedAt: 5_000,
      moves: [
        staked("alice", "white", 1),
        staked("bob", "black", 2, FEN_AFTER_E5),
      ],
    });

    expect(await finish(stack, "gm_once")).toMatchObject({ resolved: true });
    const firstReplay = stack.db
      .select({ replayJson: schema.games.replayJson })
      .from(schema.games)
      .where(eq(schema.games.id, "gm_once"))
      .get()?.replayJson;
    expect(firstReplay).not.toBeNull();

    expect(await finish(stack, "gm_once")).toMatchObject({ resolved: false });
    const alice = stack.db
      .select()
      .from(schema.players)
      .where(eq(schema.players.address, "alice"))
      .get();
    expect(alice).toMatchObject({ wins: 1, draws: 0, losses: 0 });
    const secondReplay = stack.db
      .select({ replayJson: schema.games.replayJson })
      .from(schema.games)
      .where(eq(schema.games.id, "gm_once"))
      .get()?.replayJson;
    expect(secondReplay).toBe(firstReplay);
    expect(stack.db.select().from(schema.payoutJobs).all()).toHaveLength(1);
  });

  it("public_replay_is_terminal_only_and_strips_addresses", async () => {
    const stack = setup();
    seedPlayer(stack.db, "REPLAYALICEADDRESS", "alice-nick");
    seedPlayer(stack.db, "REPLAYBOBADDRESS", "bob-nick");
    seedGame(stack.db, {
      id: "gm_live",
      name: "still-live",
      status: "active",
      moves: [staked("REPLAYALICEADDRESS", "white", 1)],
    });
    seedGame(stack.db, {
      id: "gm_replay",
      name: "replay-game",
      status: "finished",
      result: "white",
      termination: "checkmate",
      history: ["e2e4", "e7e5"],
      finishedAt: 5_000,
      moves: [
        staked("REPLAYALICEADDRESS", "white", 1),
        {
          player: "REPLAYBOBADDRESS",
          side: "black",
          demo: true,
          stake: 0,
          ply: 2,
          uci: "e7e5",
          san: "e5",
          fenAfter: FEN_AFTER_E5,
        },
      ],
    });
    await finish(stack, "gm_replay");
    stack.db
      .update(schema.players)
      .set({ draws: 8, losses: 1 })
      .where(eq(schema.players.address, "REPLAYALICEADDRESS"))
      .run();

    // Unknown and non-terminal ids are indistinguishable (I7).
    for (const id of ["gm_missing", "gm_live"]) {
      const res = await stack.app.request(`/api/v1/games/${id}/replay`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe(
        "GAME_NOT_FOUND",
      );
    }

    const res = await stack.app.request("/api/v1/games/gm_replay/replay");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("REPLAYALICEADDRESS");
    expect(text).not.toContain("REPLAYBOBADDRESS");
    const body = JSON.parse(text) as {
      gameId: string;
      name: string;
      result: string;
      termination: string;
      plies: {
        ply: number;
        fenAfter: string;
        demo: boolean;
        author: Record<string, unknown>;
      }[];
      pgn: string;
    };
    expect(body).toMatchObject({
      gameId: "gm_replay",
      name: "replay-game",
      result: "white",
      termination: "checkmate",
    });
    const stored = JSON.parse(
      stack.db
        .select({ replayJson: schema.games.replayJson })
        .from(schema.games)
        .where(eq(schema.games.id, "gm_replay"))
        .get()?.replayJson ?? "{}",
    ) as { pgn: string; plies: { fenAfter: string }[] };
    expect(body.pgn).toBe(stored.pgn);
    expect(body.pgn).toContain("1. e4 e5");
    expect(body.plies.map((ply) => ply.fenAfter)).toEqual(
      stored.plies.map((ply) => ply.fenAfter),
    );
    expect(body.plies.map((ply) => ply.demo)).toEqual([false, true]);
    for (const ply of body.plies) {
      expect(Object.keys(ply.author).sort()).toEqual([
        "kind",
        "movesTotal",
        "nickname",
        "winratePct",
      ]);
    }
    expect(body.plies[0]?.author.nickname).toBe("alice-nick");
    expect(body.plies[0]?.author.winratePct).toBe(50);

    // Nickname joins are live: a rename shows on the next read.
    stack.db
      .update(schema.players)
      .set({ nickname: "renamed-alice" })
      .where(eq(schema.players.address, "REPLAYALICEADDRESS"))
      .run();
    const renamed = (await (
      await stack.app.request("/api/v1/games/gm_replay/replay")
    ).json()) as { plies: { author: { nickname: string } }[] };
    expect(renamed.plies[0]?.author.nickname).toBe("renamed-alice");
  });

  it("finished_cards_and_public_replay_explain_a_material_win_on_repetition", async () => {
    const stack = setup();
    seedPlayer(stack.db, "MATERIALWHITE", "material-white");
    seedPlayer(stack.db, "MATERIALBLACK", "material-black");
    const finalFen = "4k3/8/8/8/8/8/P7/3QK3 b - - 0 2";
    seedGame(stack.db, {
      id: "gm_material",
      name: "material-repetition",
      status: "finished",
      result: "white",
      termination: "threefold",
      rules: { REPETITION_WIN_MARGIN: 4 },
      history: ["e2e4", "e7e5"],
      finishedAt: 5_000,
      moves: [
        staked("MATERIALWHITE", "white", 1),
        {
          ...staked("MATERIALBLACK", "black", 2, finalFen),
          fenAfter: finalFen,
        },
      ],
    });
    await finish(stack, "gm_material");

    const finished = (await (
      await stack.app.request("/api/v1/my/games?status=finished&page=1", {
        headers: bearer(stack, "MATERIALWHITE"),
      })
    ).json()) as {
      items: {
        repetitionAdjudication: {
          whiteMaterialPoints: number;
          blackMaterialPoints: number;
          winMargin: number;
        };
      }[];
    };
    const replay = (await (
      await stack.app.request("/api/v1/games/gm_material/replay")
    ).json()) as {
      repetitionAdjudication: {
        whiteMaterialPoints: number;
        blackMaterialPoints: number;
        winMargin: number;
      };
    };
    const expected = {
      whiteMaterialPoints: 10,
      blackMaterialPoints: 0,
      winMargin: 4,
    };
    expect(finished.items[0]?.repetitionAdjudication).toEqual(expected);
    expect(replay.repetitionAdjudication).toEqual(expected);
  });

  it("share_card_uses_only_escaped_public_replay_data", async () => {
    const stack = setup();
    seedPlayer(stack.db, "CARDALICEADDRESS", "alice-nick");
    seedPlayer(stack.db, "CARDBOBADDRESS", "bob-nick");
    seedGame(stack.db, {
      id: "gm_live_card",
      name: "live-card",
      status: "active",
      moves: [staked("CARDALICEADDRESS", "white", 1)],
    });
    seedGame(stack.db, {
      id: "gm_card",
      name: "card-game",
      status: "finished",
      result: "white",
      termination: "checkmate",
      history: ["e2e4", "e7e5"],
      finishedAt: 5_000,
      moves: [
        staked("CARDALICEADDRESS", "white", 1),
        {
          player: "CARDBOBADDRESS",
          side: "black",
          demo: true,
          stake: 0,
          ply: 2,
          uci: "e7e5",
          san: "e5",
          fenAfter: FEN_AFTER_E5,
        },
      ],
    });
    await finish(stack, "gm_card");

    // The default (final-position) card is a 1200×630 PNG with the right headers.
    const res = await stack.app.request("/api/v1/games/gm_card/card.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const png = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 630]);

    // ?ply selects a position; malformed or out-of-range is a 400.
    expect(
      (await stack.app.request("/api/v1/games/gm_card/card.png?ply=1")).status,
    ).toBe(200);
    for (const bad of ["999", "0", "abc", "1.5"]) {
      expect(
        (await stack.app.request(`/api/v1/games/gm_card/card.png?ply=${bad}`))
          .status,
      ).toBe(400);
    }

    // Unknown and non-terminal ids are the same 404 (I7 parity with replay).
    for (const id of ["gm_missing", "gm_live_card"]) {
      const miss = await stack.app.request(`/api/v1/games/${id}/card.png`);
      expect(miss.status).toBe(404);
      expect(((await miss.json()) as { error: string }).error).toBe(
        "GAME_NOT_FOUND",
      );
    }

    // Every dynamic value is XML-escaped and no address ever reaches the SVG.
    const svg = buildCardSvg({
      gameId: `gm_<script>"drop"&'go'`,
      authorNickname: "<b>nick</b>",
      outcome: "WON",
      fen: FEN_AFTER_E5,
      moveUci: "e7e5",
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<b>nick</b>");
    expect(svg).not.toContain("CARDALICEADDRESS");
    expect(svg).not.toContain("CARDBOBADDRESS");

    // The LRU is bounded by its configured maximum.
    const cache = new CardCache(2);
    for (const key of ["a", "b", "c"]) {
      await cache.render(
        key,
        buildCardSvg({
          gameId: key,
          authorNickname: null,
          outcome: "DRAW",
          fen: STARTING_FEN,
          moveUci: "e2e4",
        }),
      );
    }
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});
