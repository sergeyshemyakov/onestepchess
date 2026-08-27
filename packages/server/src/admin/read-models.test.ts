import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, schema } from "../db/open.js";
import * as schemaModule from "../db/schema.js";
import { winratePct } from "../player-stats.js";
import {
  type AdminReadDeps,
  adminActivity,
  adminBonuses,
  adminErrors,
  adminGames,
  adminPlayers,
} from "./read-models.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const PAGE_SIZE = 25;

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const open: Database.Database[] = [];

function openFixture(captured?: string[]) {
  const sqlite = new Database(":memory:", {
    ...(captured === undefined
      ? {}
      : {
          verbose: (message?: unknown) => {
            if (typeof message === "string") captured.push(message);
          },
        }),
  });
  open.push(sqlite);
  const db = drizzle(sqlite, { schema: schemaModule });
  migrate(db, { migrationsFolder });
  // Claims are seeded directly, including one whose player row is absent, so
  // the defensive "missing player counts as non-agent" branch is reachable.
  sqlite.pragma("foreign_keys = OFF");
  return db as Db;
}

afterEach(() => {
  for (const sqlite of open.splice(0)) sqlite.close();
});

function deps(db: Db): AdminReadDeps {
  return {
    db,
    now: () => NOW,
    config: () => ({ BONUS_DAILY_CAP: 50, QUOTA_DEMO: 5 }),
    secrets: [],
  } as unknown as AdminReadDeps;
}

type ClaimSeed = {
  readonly id: string;
  readonly player: string;
  readonly demo: boolean;
  readonly status: "open" | "moved" | "expired";
  readonly createdAt: number;
  readonly movedAt: number | null;
};

function seed(db: Db) {
  db.insert(schema.players)
    .values([
      {
        address: "alice",
        kind: "human",
        nickname: "alice",
        createdAt: NOW - HOUR,
      },
      {
        address: "bob",
        kind: "human",
        nickname: "bob",
        createdAt: NOW - 40 * DAY,
      },
      {
        address: "bot",
        kind: "agent",
        nickname: "bot",
        createdAt: NOW - 2 * HOUR,
      },
      {
        address: "guest1",
        kind: "guest",
        nickname: null,
        createdAt: NOW - HOUR,
      },
      {
        address: "nick-less",
        kind: "human",
        nickname: null,
        createdAt: NOW - HOUR,
      },
    ])
    .run();

  const game = (
    id: string,
    finishedAt: number | null,
    resolvedAt: number | null,
  ) => ({
    id,
    name: `game-${id}`,
    fen: "start",
    rulesJson: "{}",
    lastPlyAt: NOW,
    createdAt: NOW - 8 * HOUR,
    finishedAt,
    resolvedAt,
    status: "finished" as const,
  });
  db.insert(schema.games)
    .values([
      game("g_in", NOW - 2 * HOUR, NOW - 2 * HOUR),
      game("g_old", NOW - 40 * DAY, NOW - 40 * DAY),
      game("g_unresolved", NOW - 3 * HOUR, null),
      game("g_future", NOW + HOUR, NOW + HOUR),
    ])
    .run();

  const claims: ClaimSeed[] = [
    // in-window, staked human move
    {
      id: "c1",
      player: "alice",
      demo: false,
      status: "moved",
      createdAt: NOW - 2 * HOUR,
      movedAt: NOW - HOUR,
    },
    // in-window demo move by the same human -> alice converted demo->staked
    {
      id: "c2",
      player: "alice",
      demo: true,
      status: "moved",
      createdAt: NOW - 3 * HOUR,
      movedAt: NOW - 2 * HOUR - 300_000,
    },
    // demo-only human
    {
      id: "c3",
      player: "bob",
      demo: true,
      status: "moved",
      createdAt: NOW - 4 * HOUR,
      movedAt: NOW - 3 * HOUR - 600_000,
    },
    {
      id: "c4",
      player: "bot",
      demo: false,
      status: "moved",
      createdAt: NOW - 5 * HOUR,
      movedAt: NOW - 4 * HOUR,
    },
    {
      id: "c5",
      player: "alice",
      demo: false,
      status: "expired",
      createdAt: NOW - 6 * HOUR,
      movedAt: null,
    },
    // created exactly on the 24h lower bound
    {
      id: "c6",
      player: "alice",
      demo: false,
      status: "open",
      createdAt: NOW - DAY,
      movedAt: null,
    },
    // moved exactly at `now`, created outside the 24h window
    {
      id: "c7",
      player: "alice",
      demo: false,
      status: "moved",
      createdAt: NOW - 30 * HOUR,
      movedAt: NOW,
    },
    // future stamps stay out of every window, `all` included
    {
      id: "c8",
      player: "alice",
      demo: false,
      status: "moved",
      createdAt: NOW + HOUR,
      movedAt: NOW + HOUR,
    },
    // player row absent on purpose
    {
      id: "c9",
      player: "ghost",
      demo: false,
      status: "moved",
      createdAt: NOW - 7 * HOUR,
      movedAt: NOW - 6 * HOUR,
    },
    {
      id: "c10",
      player: "alice",
      demo: false,
      status: "moved",
      createdAt: NOW - 40 * DAY,
      movedAt: NOW - 40 * DAY,
    },
  ];
  db.insert(schema.claims)
    .values(
      claims.map((claim) => ({
        ...claim,
        gameId: "g_in",
        side: "white" as const,
        stakeMicrousdc: 1_000,
        deadline: claim.createdAt + HOUR,
      })),
    )
    .run();

  db.insert(schema.stakeEntries)
    .values([
      // resolved in-window: alice wins, bot loses, bob is exactly break-even
      {
        id: "s1",
        gameId: "g_in",
        claimId: "c1",
        player: "alice",
        side: "white",
        kind: "human",
        amount: 1_000,
        payTxid: "t1",
        ply: 1,
        payoutAmount: 2_500,
        createdAt: NOW - 2 * HOUR,
      },
      {
        id: "s2",
        gameId: "g_in",
        claimId: "c4",
        player: "bot",
        side: "black",
        kind: "agent",
        amount: 1_000,
        payTxid: "t2",
        ply: 2,
        payoutAmount: 0,
        createdAt: NOW - 5 * HOUR,
      },
      {
        id: "s3",
        gameId: "g_in",
        claimId: "c7",
        player: "bob",
        side: "white",
        kind: "human",
        amount: 1_000,
        payTxid: "t3",
        ply: 3,
        payoutAmount: 1_000,
        createdAt: NOW - 4 * HOUR,
      },
      // a null payout is skipped by the leaderboard entirely, not treated as 0
      {
        id: "s4",
        gameId: "g_in",
        claimId: "c5",
        player: "nick-less",
        side: "black",
        kind: "human",
        amount: 1_000,
        payTxid: "t4",
        ply: 4,
        payoutAmount: null,
        createdAt: NOW - 6 * HOUR,
      },
      // unresolved game: excluded from the leaderboard, counted in stake volume
      {
        id: "s5",
        gameId: "g_unresolved",
        claimId: "c3",
        player: "alice",
        side: "white",
        kind: "human",
        amount: 7_000,
        payTxid: "t5",
        ply: 1,
        payoutAmount: 9_000,
        createdAt: NOW - 3 * HOUR,
      },
      {
        id: "s6",
        gameId: "g_old",
        claimId: "c10",
        player: "alice",
        side: "white",
        kind: "human",
        amount: 1_000,
        payTxid: "t6",
        ply: 1,
        payoutAmount: 500,
        createdAt: NOW - 40 * DAY,
      },
    ])
    .run();

  db.insert(schema.payoutJobs)
    .values([
      {
        id: "p1",
        gameId: "g_in",
        recipient: "alice",
        amount: 2_500,
        reason: "resolution",
        status: "confirmed",
        createdAt: NOW - 2 * HOUR,
      },
      {
        id: "p2",
        gameId: "g_in",
        recipient: "bob",
        amount: 900,
        reason: "refund",
        status: "failed",
        createdAt: NOW - 2 * HOUR,
      },
      {
        id: "p3",
        gameId: "g_old",
        recipient: "alice",
        amount: 400,
        reason: "resolution",
        status: "confirmed",
        createdAt: NOW - 40 * DAY,
      },
    ])
    .run();

  db.insert(schema.ledger)
    .values([
      {
        ts: NOW - 2 * HOUR,
        account: "protocol",
        deltaMicrousdc: 120,
        refType: "fee",
        refId: "g_in",
      },
      {
        ts: NOW - 2 * HOUR,
        account: "treasury",
        deltaMicrousdc: -2_500,
        refType: "payout",
        refId: "g_in",
      },
      {
        ts: NOW - 2 * HOUR,
        account: "player",
        deltaMicrousdc: 40,
        refType: "stake",
        refId: "g_in",
      },
      {
        ts: NOW - 40 * DAY,
        account: "protocol",
        deltaMicrousdc: 999,
        refType: "fee",
        refId: "g_old",
      },
      {
        ts: NOW + HOUR,
        account: "protocol",
        deltaMicrousdc: 777,
        refType: "fee",
        refId: "g_future",
      },
    ])
    .run();

  db.insert(schema.errorLog)
    .values(
      Array.from({ length: 30 }, (_, index) => ({
        ts: NOW - index * 1_000,
        level: index % 2 === 0 ? "error" : "warn",
        code: "BOOM",
        requestId: `r${index}`,
        contextJson: JSON.stringify({ index }),
      })),
    )
    .run();

  db.insert(schema.bonuses)
    .values([
      {
        player: "alice",
        status: "funded",
        algoAmount: 250_000,
        usdcAmount: 200_000,
        claimIp: "203.0.113.1",
        claimedAt: NOW - HOUR,
        optInDeadlineAt: NOW + DAY,
        fundedAt: NOW - HOUR,
      },
      {
        player: "bob",
        status: "claimed",
        algoAmount: 250_000,
        usdcAmount: 200_000,
        claimIp: "203.0.113.2",
        claimedAt: NOW - 40 * DAY,
        optInDeadlineAt: NOW - 39 * DAY,
      },
      // no players row: excluded by the inner join, from the page and the counts
      {
        player: "ghost",
        status: "claimed",
        algoAmount: 1,
        usdcAmount: 1,
        claimIp: "203.0.113.3",
        claimedAt: NOW - 2 * HOUR,
        optInDeadlineAt: NOW + DAY,
      },
    ])
    .run();

  db.insert(schema.fundingJobs)
    .values([
      {
        id: "f1",
        player: "alice",
        leg: "algo",
        amount: 250_000,
        status: "confirmed",
        payloadB64: "AA",
        txid: "ftx1",
        lastValidRound: 1,
        createdAt: NOW - HOUR,
        updatedAt: NOW - HOUR,
      },
      {
        id: "f2",
        player: "alice",
        leg: "usdc",
        amount: 200_000,
        status: "confirmed",
        payloadB64: "AA",
        txid: "ftx2",
        lastValidRound: 1,
        createdAt: NOW - HOUR,
        updatedAt: NOW - HOUR,
      },
      {
        id: "f3",
        player: "bob",
        leg: "usdc",
        amount: 200_000,
        status: "failed",
        createdAt: NOW - HOUR,
        updatedAt: NOW - HOUR,
      },
    ])
    .run();

  return db;
}

// ---------------------------------------------------------------------------
// Reference model: the pre-rewrite JS read path, kept as the golden implementation
// the SQL rewrite must agree with (spec 2026-08-27, cards A1-A3).
// ---------------------------------------------------------------------------

function iso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}
function pageOf<T>(items: readonly T[], pageNumber: number) {
  const total = items.length;
  return {
    items: items.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE),
    page: pageNumber,
    pageCount: total === 0 ? 0 : Math.ceil(total / PAGE_SIZE),
    total,
  };
}
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ] as number;
}
function pct(n: number, d: number): number | null {
  return d === 0 ? null : (n / d) * 100;
}

function referenceActivity(db: Db, window: "24h" | "7d" | "30d" | "all") {
  const now = NOW;
  const from =
    window === "all"
      ? null
      : now - (window === "24h" ? 24 : window === "7d" ? 168 : 720) * HOUR;
  const inside = (at: number | null) =>
    at !== null && (from === null || at >= from) && at <= now;
  const players = db.select().from(schema.players).all();
  const byAddress = new Map(players.map((p) => [p.address, p]));
  const allClaims = db.select().from(schema.claims).all();
  const claims = allClaims.filter((c) => inside(c.createdAt));
  const moved = allClaims.filter(
    (c) => c.status === "moved" && inside(c.movedAt),
  );
  const stakedMoved = moved.filter((c) => !c.demo);
  const humanStaked = stakedMoved.filter(
    (c) => byAddress.get(c.player)?.kind === "human",
  );
  const agentStaked = stakedMoved.filter(
    (c) => byAddress.get(c.player)?.kind === "agent",
  );
  const humanAddresses = new Set(humanStaked.map((c) => c.player));
  const demoHumanAddresses = new Set(
    moved
      .filter((c) => c.demo)
      .map((c) => c.player)
      .filter((a) => byAddress.get(a)?.kind === "human"),
  );
  const allStakes = db.select().from(schema.stakeEntries).all();
  const humanClaims = claims.filter(
    (c) => byAddress.get(c.player)?.kind !== "agent",
  );
  const agentClaims = claims.filter(
    (c) => byAddress.get(c.player)?.kind === "agent",
  );
  const latencies = humanClaims
    .filter((c) => c.movedAt !== null)
    .map((c) => ((c.movedAt as number) - c.createdAt) / 1_000);
  const resolved = new Set(
    db
      .select()
      .from(schema.games)
      .all()
      .filter((g) => inside(g.resolvedAt))
      .map((g) => g.id),
  );
  const pnl = new Map<string, number>();
  for (const entry of allStakes.filter((s) => resolved.has(s.gameId))) {
    if (entry.payoutAmount === null) continue;
    pnl.set(
      entry.player,
      (pnl.get(entry.player) ?? 0) + entry.payoutAmount - entry.amount,
    );
  }
  const ranked = [...pnl]
    .map(([address, pnlMicroUsdc]) => ({
      address,
      nickname: byAddress.get(address)?.nickname ?? "",
      pnlMicroUsdc,
    }))
    .sort(
      (a, b) =>
        b.pnlMicroUsdc - a.pnlMicroUsdc || a.address.localeCompare(b.address),
    );
  const ledger = db
    .select()
    .from(schema.ledger)
    .all()
    .filter((e) => inside(e.ts));
  return {
    window,
    fromAt: iso(from),
    toAt: new Date(now).toISOString(),
    counts: {
      activeHumans: humanAddresses.size,
      activeAgents: new Set(agentStaked.map((c) => c.player)).size,
      demoOnlyPlayers: [...demoHumanAddresses].filter(
        (a) => !humanAddresses.has(a),
      ).length,
      registrations: players.filter(
        (p) => p.kind !== "guest" && inside(p.createdAt),
      ).length,
      humanMoves: humanStaked.length,
      agentMoves: agentStaked.length,
      demoMoves: moved.filter((c) => c.demo).length,
      claimsCreated: claims.length,
      claimsMoved: moved.length,
      claimsExpired: claims.filter((c) => c.status === "expired").length,
      gamesFinished: db
        .select()
        .from(schema.games)
        .all()
        .filter((g) => inside(g.finishedAt)).length,
    },
    money: {
      stakeVolumeMicroUsdc: allStakes
        .filter((s) => inside(s.createdAt))
        .reduce((sum, s) => sum + s.amount, 0),
      payoutVolumeMicroUsdc: db
        .select()
        .from(schema.payoutJobs)
        .all()
        .filter((j) => j.status === "confirmed" && inside(j.createdAt))
        .reduce((sum, j) => sum + j.amount, 0),
      protocolTakeMicroUsdc: ledger
        .filter((e) => e.account === "protocol")
        .reduce((sum, e) => sum + e.deltaMicrousdc, 0),
      treasuryNetFlowMicroUsdc: ledger
        .filter((e) => e.account === "treasury")
        .reduce((sum, e) => sum + e.deltaMicrousdc, 0),
    },
    tripwires: {
      claimMovePctHuman: pct(
        humanClaims.filter((c) => c.status === "moved").length,
        humanClaims.length,
      ),
      claimMovePctAgent: pct(
        agentClaims.filter((c) => c.status === "moved").length,
        agentClaims.length,
      ),
      demoSharePct: pct(moved.filter((c) => c.demo).length, moved.length),
      demoToStakedPct: pct(
        [...demoHumanAddresses].filter((a) => humanAddresses.has(a)).length,
        demoHumanAddresses.size,
      ),
      humanMoveLatencyP50Seconds: percentile(latencies, 50),
      humanMoveLatencyP95Seconds: percentile(latencies, 95),
      quotaSaturationPct: null,
      topWinners: ranked.filter((i) => i.pnlMicroUsdc > 0).slice(0, 5),
      topLosers: ranked
        .filter((i) => i.pnlMicroUsdc < 0)
        .sort((a, b) => a.pnlMicroUsdc - b.pnlMicroUsdc)
        .slice(0, 5),
    },
  };
}

function referencePlayers(
  db: Db,
  input: {
    readonly kind?: "human" | "agent";
    readonly q?: string;
    readonly page: number;
  },
) {
  const conditions = [
    inArray(schema.players.kind, ["human", "agent"] as const),
  ];
  if (input.kind !== undefined)
    conditions.push(eq(schema.players.kind, input.kind) as never);
  if (input.q !== undefined && input.q.length > 0) {
    const q = `%${input.q}%`;
    conditions.push(
      or(
        like(schema.players.address, q),
        like(schema.players.nickname, q),
      ) as never,
    );
  }
  const rows = db
    .select()
    .from(schema.players)
    .where(and(...conditions))
    .all();
  const selected = new Set(rows.map((p) => p.address));
  const lastActive = new Map<string, number>();
  for (const claim of db.select().from(schema.claims).all()) {
    if (!selected.has(claim.player)) continue;
    const at = Math.max(claim.createdAt, claim.movedAt ?? claim.createdAt);
    lastActive.set(
      claim.player,
      Math.max(lastActive.get(claim.player) ?? 0, at),
    );
  }
  const pnl = new Map<string, number>();
  for (const stake of db.select().from(schema.stakeEntries).all()) {
    if (!selected.has(stake.player)) continue;
    pnl.set(
      stake.player,
      (pnl.get(stake.player) ?? 0) + (stake.payoutAmount ?? 0) - stake.amount,
    );
  }
  return pageOf(
    rows
      .map((player) => ({
        address: player.address,
        nickname: player.nickname,
        kind: player.kind as "human" | "agent",
        createdAt: new Date(player.createdAt).toISOString(),
        lastActiveAt: new Date(
          lastActive.get(player.address) ?? player.createdAt,
        ).toISOString(),
        banned: player.banned,
        deprioritizedUntil: iso(player.deprioritizedUntil),
        abandonCount: player.abandonCount,
        points: player.points,
        stats: {
          moves: player.wins + player.draws + player.losses,
          wins: player.wins,
          draws: player.draws,
          losses: player.losses,
          winratePct: winratePct(player.wins, player.losses),
        },
        netPnlMicroUsdc: pnl.get(player.address) ?? 0,
      }))
      .sort(
        (l, r) =>
          r.lastActiveAt.localeCompare(l.lastActiveAt) ||
          r.createdAt.localeCompare(l.createdAt) ||
          l.address.localeCompare(r.address),
      ),
    input.page,
  );
}

describe("admin activity read model (A1)", () => {
  it("admin_activity_matches_the_reference_model_on_every_window", () => {
    const db = seed(openFixture());
    for (const window of ["24h", "7d", "30d", "all"] as const) {
      expect(adminActivity(deps(db), window)).toEqual(
        referenceActivity(db, window),
      );
    }
  });

  it("admin_activity_windows_include_both_edges_and_exclude_future_stamps", () => {
    const db = seed(openFixture());
    const day = adminActivity(deps(db), "24h");
    // c6 sits exactly on `from`; c7 moved exactly at `to`; c8 is stamped ahead.
    expect(day.counts.claimsCreated).toBe(7);
    expect(day.counts.claimsMoved).toBe(6);
    expect(adminActivity(deps(db), "all").money.protocolTakeMicroUsdc).toBe(
      120 + 999,
    );
  });

  it("admin_activity_leaderboards_are_top_five_by_pnl_in_both_directions", () => {
    const db = seed(openFixture());
    const { topWinners, topLosers } = adminActivity(deps(db), "24h").tripwires;
    expect(topWinners).toEqual([
      { address: "alice", nickname: "alice", pnlMicroUsdc: 1_500 },
    ]);
    expect(topLosers).toEqual([
      { address: "bot", nickname: "bot", pnlMicroUsdc: -1_000 },
    ]);
  });

  it("admin_activity_leaderboards_cap_at_five_ordered_by_pnl_then_address", () => {
    const db = seed(openFixture());
    const extra = Array.from({ length: 12 }, (_, index) => `w${index}`);
    db.insert(schema.players)
      .values(
        extra.map((address) => ({
          address,
          kind: "human" as const,
          nickname: address,
          createdAt: NOW - HOUR,
        })),
      )
      .run();
    db.insert(schema.stakeEntries)
      .values(
        extra.map((address, index) => ({
          id: `se-${address}`,
          gameId: "g_in",
          claimId: `cl-${address}`,
          player: address,
          side: "white" as const,
          kind: "human" as const,
          amount: 1_000,
          payTxid: `tx-${address}`,
          ply: 1,
          // ties on purpose: every winner nets +10, so address breaks the tie
          payoutAmount: index < 6 ? 1_010 : 990,
          createdAt: NOW - HOUR,
        })),
      )
      .run();
    const { topWinners, topLosers } = adminActivity(deps(db), "24h").tripwires;
    expect(topWinners).toHaveLength(5);
    expect(topLosers).toHaveLength(5);
    expect(topWinners.map((row) => row.address)).toEqual([
      "alice",
      "w0",
      "w1",
      "w2",
      "w3",
    ]);
    expect(topLosers.map((row) => row.address)).toEqual([
      "bot",
      "w10",
      "w11",
      "w6",
      "w7",
    ]);
  });

  it("admin_activity_materializes_no_unbounded_table_read", () => {
    const captured: string[] = [];
    const db = seed(openFixture(captured));
    db.insert(schema.claims)
      .values(
        Array.from({ length: 2_000 }, (_, index) => ({
          id: `bulk-${index}`,
          gameId: "g_in",
          player: "alice",
          side: "white" as const,
          demo: false,
          stakeMicrousdc: 1_000,
          status: "moved" as const,
          createdAt: NOW - HOUR,
          deadline: NOW,
          movedAt: NOW - HOUR + index,
        })),
      )
      .run();
    captured.length = 0;
    adminActivity(deps(db), "all");

    const unbounded = captured
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter((statement) => statement.toLowerCase().startsWith("select"))
      .filter((statement) => {
        const lower = statement.toLowerCase();
        const aggregated = /\b(count|sum)\s*\(/.test(lower);
        const limited = / limit /.test(lower);
        return !aggregated && !limited;
      });
    expect(unbounded).toEqual([]);
  });
});

describe("admin players read model (A2)", () => {
  it("admin_players_matches_the_reference_model_for_filtered_pages", () => {
    const db = seed(openFixture());
    for (const input of [
      { page: 1 },
      { page: 2 },
      { page: 1, kind: "human" as const },
      { page: 1, kind: "agent" as const },
      { page: 1, q: "bo" },
    ]) {
      expect(adminPlayers(deps(db), input)).toEqual(
        referencePlayers(db, input),
      );
    }
  });

  it("admin_players_aggregates_pnl_only_for_the_returned_page", () => {
    const captured: string[] = [];
    const db = seed(openFixture(captured));
    captured.length = 0;
    const result = adminPlayers(deps(db), { page: 1, kind: "agent" });
    expect(result.items.map((row) => row.address)).toEqual(["bot"]);
    const pnlQuery = captured
      .map((statement) => statement.replace(/\s+/g, " "))
      .find((statement) => statement.includes("payout_amount"));
    expect(pnlQuery).toBeDefined();
    // Scoped to this page's one address, never the whole stake_entries table.
    expect(pnlQuery).toContain("'bot'");
    expect(pnlQuery).not.toContain("'alice'");
  });
});

describe("admin list pagination (A3)", () => {
  it("admin_games_issues_a_constant_query_count_per_page_size", () => {
    const captured: string[] = [];
    const db = seed(openFixture(captured));
    db.insert(schema.games)
      .values({
        id: "g_solo",
        name: "game-g_solo",
        fen: "start",
        rulesJson: "{}",
        status: "endspiel",
        lastPlyAt: NOW,
        createdAt: NOW - HOUR,
      })
      .run();
    const selectsFor = (status?: string) => {
      captured.length = 0;
      const result = adminGames(deps(db), {
        page: 1,
        ...(status === undefined ? {} : { status }),
      });
      return {
        selects: captured.filter((statement) =>
          statement.trim().toLowerCase().startsWith("select"),
        ).length,
        items: result.items.length,
      };
    };
    const one = selectsFor("endspiel");
    const many = selectsFor();
    expect(one.items).toBe(1);
    expect(many.items).toBe(5);
    // One page of games costs the same four queries whether it holds 1 row or
    // 5: the old read model ran one gameSummary per row.
    expect(many.selects).toBe(one.selects);
    expect(many.selects).toBe(4);
  });

  it("admin_errors_pages_in_sql_with_the_full_total", () => {
    const db = seed(openFixture());
    const first = adminErrors(deps(db), { page: 1 });
    const second = adminErrors(deps(db), { page: 2 });
    expect(first).toMatchObject({ page: 1, pageCount: 2, total: 30 });
    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(5);
    expect(adminErrors(deps(db), { page: 1, level: "warn" }).total).toBe(15);
    const ids = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(ids).size).toBe(30);
  });

  it("admin_bonuses_counts_and_totals_ignore_rows_without_a_player", () => {
    const db = seed(openFixture());
    const result = adminBonuses(deps(db), 1);
    expect(result).toMatchObject({
      totalClaimed: 2,
      todayClaimed: 1,
      totalAlgoMicro: 250_000,
      totalUsdcMicro: 200_000,
      page: 1,
      pageCount: 1,
      total: 2,
    });
    expect(result.items.map((row) => row.address)).toEqual(["alice", "bob"]);
    expect(result.items[0]?.lifetimeStakedMoves).toBe(3);
  });
});
