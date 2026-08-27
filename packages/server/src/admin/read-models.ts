import type { PaymentRail } from "@onestepchess/core";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { fundingGroundTruth } from "../bonuses/funding.js";
import type { ServerConfig } from "../config.js";
import type { CoordinatorViews } from "../coordinator/views.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import type { Metrics } from "../metrics.js";
import { sanitizeOperationalPayload } from "../operations/alerts.js";
import { readPauseState } from "../operations/pause.js";
import {
  type OperationalState,
  readReconciliationReport,
} from "../operations/reconciliation.js";
import { winratePct } from "../player-stats.js";
import {
  configDescription,
  configEditable,
  configEffect,
} from "./config-metadata.js";

const HOUR_MS = 3_600_000;
const PAGE_SIZE = 25;

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function claimSummary(
  claim: typeof schema.claims.$inferSelect,
  nickname: string | null,
) {
  return {
    id: claim.id,
    player: claim.player,
    nickname,
    side: claim.side,
    demo: claim.demo,
    status: claim.status,
    stakeMicroUsdc: claim.stakeMicrousdc,
    move:
      claim.moveUci === null || claim.moveSan === null
        ? null
        : { uci: claim.moveUci, san: claim.moveSan },
    claimedAt: new Date(claim.createdAt).toISOString(),
    deadline: new Date(claim.deadline).toISOString(),
    movedAt: iso(claim.movedAt),
  };
}

/** Page envelope for list endpoints. The rows arrive already sliced by SQL
 * `LIMIT`/`OFFSET`, so only the total is needed to derive the page count. */
function paged<T>(items: readonly T[], pageNumber: number, total: number) {
  return {
    items,
    page: pageNumber,
    pageCount: total === 0 ? 0 : Math.ceil(total / PAGE_SIZE),
    total,
  };
}

function offsetOf(pageNumber: number): number {
  return (pageNumber - 1) * PAGE_SIZE;
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : (numerator / denominator) * 100;
}

export type AdminReadDeps = {
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly views: CoordinatorViews;
  readonly config: () => ServerConfig;
  readonly baseConfig: ServerConfig;
  readonly state: OperationalState;
  readonly metrics?: Metrics;
  readonly clientCount: () => number;
  readonly now: () => number;
  readonly secrets?: readonly string[];
};

function statusCounts(
  db: Db,
): Record<"pending" | "prepared" | "submitted" | "failed", number> {
  const result = { pending: 0, prepared: 0, submitted: 0, failed: 0 };
  for (const row of db
    .select({ status: schema.payoutJobs.status, count: sql<number>`count(*)` })
    .from(schema.payoutJobs)
    .where(
      inArray(
        schema.payoutJobs.status,
        Object.keys(result) as (keyof typeof result)[],
      ),
    )
    .groupBy(schema.payoutJobs.status)
    .all()) {
    if (row.status in result)
      result[row.status as keyof typeof result] = Number(row.count);
  }
  return result;
}

export async function adminOverview(deps: AdminReadDeps) {
  const pause = readPauseState(deps.db);
  const balances = await deps.rail.getBalances(deps.rail.treasuryAddress);
  const bonusBalances = await deps.rail.getBalances(deps.rail.bonusAddress);
  const cfg = deps.config();
  let active = 0;
  let endspiel = 0;
  for (const game of deps.views.games.values()) {
    if (game.status === "active") active += 1;
    else endspiel += 1;
  }
  const payouts = statusCounts(deps.db);
  const metrics = deps.metrics?.snapshot({
    mode: pause.mode,
    gamesActive: active,
    gamesEndspiel: endspiel,
    claimsOpen: deps.views.openClaims.size,
    sseClients: deps.clientCount(),
  });
  const reconciliation = readReconciliationReport(deps.db);
  return {
    mode: pause.mode,
    pauseCauses: pause.causes,
    banner: pause.banner,
    pool: {
      target: cfg.GAME_POOL_TARGET,
      active,
      endspiel,
      claimsOpen: deps.views.openClaims.size,
    },
    treasury: {
      ...balances,
      capMicroUsdc: cfg.TREASURY_CAP_MICROUSDC,
      belowRefundCoverage: reconciliation?.belowRefundCoverage ?? false,
    },
    bonusAccount: {
      ...bonusBalances,
      minAlgoMicro: cfg.BONUS_MIN_ALGO_MICRO,
    },
    payouts,
    funding: fundingGroundTruth(deps.db),
    reconciliation: reconciliation ?? {
      lastRunAt: null,
      bookMicroUsdc: 0,
      chainMicroUsdc: balances.usdcMicroUsdc,
      driftMicroUsdc: -balances.usdcMicroUsdc,
      inboundToleranceMicroUsdc: 0,
      outboundToleranceMicroUsdc: 0,
      ok: false,
    },
    facilitator: {
      healthy: deps.state.facilitator.healthy,
      lastCheckAt: iso(deps.state.facilitator.lastCheckAt),
    },
    live: {
      uptimeSeconds: metrics?.uptimeSeconds ?? 0,
      sseClients: deps.clientCount(),
      settleP50Ms:
        metrics === undefined || metrics.movesSettled24h === 0
          ? null
          : metrics.settleLatencyP50Ms,
      settleP95Ms:
        metrics === undefined || metrics.movesSettled24h === 0
          ? null
          : metrics.settleLatencyP95Ms,
    },
  };
}

type ActivityWindow = "24h" | "7d" | "30d" | "all";

function windowStart(window: ActivityWindow, now: number): number | null {
  if (window === "all") return null;
  const hours = window === "24h" ? 24 : window === "7d" ? 24 * 7 : 24 * 30;
  return now - hours * HOUR_MS;
}

type WindowBounds = { readonly from: number | null; readonly to: number };

/** A row is in-window when its timestamp falls in `[from, to]`. The `all`
 * window drops only the lower bound — the upper bound still excludes rows
 * stamped in the future, and NULL timestamps stay out because comparing them
 * yields NULL rather than true. */
function windowConditions(
  column: SQLiteColumn,
  bounds: WindowBounds,
): readonly SQL[] {
  const conditions = [lte(column, bounds.to)];
  if (bounds.from !== null) conditions.push(gte(column, bounds.from));
  return conditions;
}

export function adminActivity(deps: AdminReadDeps, window: ActivityWindow) {
  const now = deps.now();
  const from = windowStart(window, now);
  const bounds: WindowBounds = { from, to: now };
  const db = deps.db;
  const claims = schema.claims;
  const players = schema.players;
  const createdInWindow = windowConditions(claims.createdAt, bounds);
  const movedInWindow = [
    eq(claims.status, "moved"),
    ...windowConditions(claims.movedAt, bounds),
  ];
  // A claim whose player row is missing counts as non-agent, matching the
  // `?.kind !== "agent"` the JS read model used.
  const nonAgent = sql`(${players.kind} is null or ${players.kind} != 'agent')`;

  const claimRow = db
    .select({
      created: sql<number>`count(*)`,
      expired: sql<number>`sum(case when ${claims.status} = 'expired' then 1 else 0 end)`,
      humanTotal: sql<number>`sum(case when ${nonAgent} then 1 else 0 end)`,
      humanMoved: sql<number>`sum(case when ${nonAgent} and ${claims.status} = 'moved' then 1 else 0 end)`,
      agentTotal: sql<number>`sum(case when ${players.kind} = 'agent' then 1 else 0 end)`,
      agentMoved: sql<number>`sum(case when ${players.kind} = 'agent' and ${claims.status} = 'moved' then 1 else 0 end)`,
    })
    .from(claims)
    .leftJoin(players, eq(players.address, claims.player))
    .where(and(...createdInWindow))
    .get();

  const movedRow = db
    .select({
      moved: sql<number>`count(*)`,
      demoMoves: sql<number>`sum(case when ${claims.demo} = 1 then 1 else 0 end)`,
      humanMoves: sql<number>`sum(case when ${claims.demo} = 0 and ${players.kind} = 'human' then 1 else 0 end)`,
      agentMoves: sql<number>`sum(case when ${claims.demo} = 0 and ${players.kind} = 'agent' then 1 else 0 end)`,
      activeHumans: sql<number>`count(distinct case when ${claims.demo} = 0 and ${players.kind} = 'human' then ${claims.player} end)`,
      activeAgents: sql<number>`count(distinct case when ${claims.demo} = 0 and ${players.kind} = 'agent' then ${claims.player} end)`,
      demoHumans: sql<number>`count(distinct case when ${claims.demo} = 1 and ${players.kind} = 'human' then ${claims.player} end)`,
    })
    .from(claims)
    .leftJoin(players, eq(players.address, claims.player))
    .where(and(...movedInWindow))
    .get();

  // Humans who moved both a demo and a staked claim in-window: the numerator
  // of demoToStakedPct, and what separates demo-only players from the rest.
  const convertedDemo = db
    .select({ player: claims.player })
    .from(claims)
    .innerJoin(players, eq(players.address, claims.player))
    .where(and(...movedInWindow, eq(players.kind, "human")))
    .groupBy(claims.player)
    .having(
      and(
        sql`sum(case when ${claims.demo} = 1 then 1 else 0 end) > 0`,
        sql`sum(case when ${claims.demo} = 0 then 1 else 0 end) > 0`,
      ),
    )
    .as("converted_demo");
  const convertedDemoPlayers = num(
    db.select({ value: sql<number>`count(*)` }).from(convertedDemo).get()
      ?.value,
  );

  const registrations = num(
    db
      .select({ value: sql<number>`count(*)` })
      .from(players)
      .where(
        and(
          ne(players.kind, "guest"),
          ...windowConditions(players.createdAt, bounds),
        ),
      )
      .get()?.value,
  );

  const gamesFinished = num(
    db
      .select({ value: sql<number>`count(*)` })
      .from(schema.games)
      .where(and(...windowConditions(schema.games.finishedAt, bounds)))
      .get()?.value,
  );

  const stakeVolume = num(
    db
      .select({
        value: sql<number>`coalesce(sum(${schema.stakeEntries.amount}), 0)`,
      })
      .from(schema.stakeEntries)
      .where(and(...windowConditions(schema.stakeEntries.createdAt, bounds)))
      .get()?.value,
  );

  const payoutVolume = num(
    db
      .select({
        value: sql<number>`coalesce(sum(${schema.payoutJobs.amount}), 0)`,
      })
      .from(schema.payoutJobs)
      .where(
        and(
          eq(schema.payoutJobs.status, "confirmed"),
          ...windowConditions(schema.payoutJobs.createdAt, bounds),
        ),
      )
      .get()?.value,
  );

  const ledgerRow = db
    .select({
      protocol: sql<number>`coalesce(sum(case when ${schema.ledger.account} = 'protocol' then ${schema.ledger.deltaMicrousdc} else 0 end), 0)`,
      treasury: sql<number>`coalesce(sum(case when ${schema.ledger.account} = 'treasury' then ${schema.ledger.deltaMicrousdc} else 0 end), 0)`,
    })
    .from(schema.ledger)
    .where(and(...windowConditions(schema.ledger.ts, bounds)))
    .get();

  // Latency percentiles pick the same index the JS implementation did, but via
  // ORDER BY + OFFSET so no per-claim value is ever materialized.
  const latencyWhere = and(
    ...createdInWindow,
    isNotNull(claims.movedAt),
    nonAgent,
  );
  const latencySpan = sql<number>`${claims.movedAt} - ${claims.createdAt}`;
  const latencyCount = num(
    db
      .select({ value: sql<number>`count(*)` })
      .from(claims)
      .leftJoin(players, eq(players.address, claims.player))
      .where(latencyWhere)
      .get()?.value,
  );
  const latencySeconds = (p: number): number | null => {
    if (latencyCount === 0) return null;
    const row = db
      .select({ value: latencySpan })
      .from(claims)
      .leftJoin(players, eq(players.address, claims.player))
      .where(latencyWhere)
      .orderBy(asc(latencySpan))
      .limit(1)
      .offset(Math.min(latencyCount - 1, Math.floor((p / 100) * latencyCount)))
      .get();
    return row === undefined ? null : num(row.value) / 1_000;
  };

  const pnlSum = sql<number>`sum(${schema.stakeEntries.payoutAmount} - ${schema.stakeEntries.amount})`;
  const pnlRanking = () =>
    db
      .select({
        address: schema.stakeEntries.player,
        nickname: sql<string>`coalesce(${players.nickname}, '')`,
        pnlMicroUsdc: pnlSum,
      })
      .from(schema.stakeEntries)
      .innerJoin(schema.games, eq(schema.games.id, schema.stakeEntries.gameId))
      .leftJoin(players, eq(players.address, schema.stakeEntries.player))
      .where(
        and(
          isNotNull(schema.stakeEntries.payoutAmount),
          ...windowConditions(schema.games.resolvedAt, bounds),
        ),
      )
      .groupBy(schema.stakeEntries.player, players.nickname)
      .limit(5);
  const topWinners = pnlRanking()
    .having(sql`${pnlSum} > 0`)
    .orderBy(desc(pnlSum), asc(schema.stakeEntries.player))
    .all();
  const topLosers = pnlRanking()
    .having(sql`${pnlSum} < 0`)
    .orderBy(asc(pnlSum), asc(schema.stakeEntries.player))
    .all();

  const claimsMoved = num(movedRow?.moved);
  const demoMoves = num(movedRow?.demoMoves);
  const demoHumans = num(movedRow?.demoHumans);
  const humanClaimTotal = num(claimRow?.humanTotal);
  const agentClaimTotal = num(claimRow?.agentTotal);

  return {
    window,
    fromAt: iso(from),
    toAt: new Date(now).toISOString(),
    counts: {
      activeHumans: num(movedRow?.activeHumans),
      activeAgents: num(movedRow?.activeAgents),
      demoOnlyPlayers: demoHumans - convertedDemoPlayers,
      registrations,
      humanMoves: num(movedRow?.humanMoves),
      agentMoves: num(movedRow?.agentMoves),
      demoMoves,
      claimsCreated: num(claimRow?.created),
      claimsMoved,
      claimsExpired: num(claimRow?.expired),
      gamesFinished,
    },
    money: {
      stakeVolumeMicroUsdc: stakeVolume,
      payoutVolumeMicroUsdc: payoutVolume,
      protocolTakeMicroUsdc: num(ledgerRow?.protocol),
      treasuryNetFlowMicroUsdc: num(ledgerRow?.treasury),
    },
    tripwires: {
      claimMovePctHuman: pct(num(claimRow?.humanMoved), humanClaimTotal),
      claimMovePctAgent: pct(num(claimRow?.agentMoved), agentClaimTotal),
      demoSharePct: pct(demoMoves, claimsMoved),
      demoToStakedPct: pct(convertedDemoPlayers, demoHumans),
      humanMoveLatencyP50Seconds: latencySeconds(50),
      humanMoveLatencyP95Seconds: latencySeconds(95),
      quotaSaturationPct: null,
      topWinners: topWinners.map((row) => ({
        ...row,
        pnlMicroUsdc: num(row.pnlMicroUsdc),
      })),
      topLosers: topLosers.map((row) => ({
        ...row,
        pnlMicroUsdc: num(row.pnlMicroUsdc),
      })),
    },
  };
}

function gameCard(
  game: typeof schema.games.$inferSelect,
  stakePotMicroUsdc: number,
  claimsOpen: number,
) {
  return {
    id: game.id,
    name: game.name,
    status: game.status,
    ply: game.ply,
    result: game.result,
    stakePotMicroUsdc,
    claimsOpen,
    createdAt: new Date(game.createdAt).toISOString(),
    finishedAt: iso(game.finishedAt),
  };
}

function gameSummary(db: Db, game: typeof schema.games.$inferSelect) {
  const stakePotMicroUsdc = num(
    db
      .select({
        value: sql<number>`coalesce(sum(${schema.stakeEntries.amount}), 0)`,
      })
      .from(schema.stakeEntries)
      .where(eq(schema.stakeEntries.gameId, game.id))
      .get()?.value,
  );
  const claimsOpen = num(
    db
      .select({ value: sql<number>`count(*)` })
      .from(schema.claims)
      .where(
        and(
          eq(schema.claims.gameId, game.id),
          eq(schema.claims.status, "open"),
        ),
      )
      .get()?.value,
  );
  return gameCard(game, stakePotMicroUsdc, claimsOpen);
}

/** Per-game aggregates for one page of games. Two grouped queries rather than
 * one join: pot and open-claim count come from different tables, so joining
 * both at once would fan the rows out and inflate each aggregate. */
function gameAggregates(db: Db, gameIds: readonly string[]) {
  if (gameIds.length === 0) {
    return {
      pots: new Map<string, number>(),
      opens: new Map<string, number>(),
    };
  }
  const pots = new Map(
    db
      .select({
        gameId: schema.stakeEntries.gameId,
        value: sql<number>`coalesce(sum(${schema.stakeEntries.amount}), 0)`,
      })
      .from(schema.stakeEntries)
      .where(inArray(schema.stakeEntries.gameId, gameIds))
      .groupBy(schema.stakeEntries.gameId)
      .all()
      .map((row) => [row.gameId, num(row.value)] as const),
  );
  const opens = new Map(
    db
      .select({
        gameId: schema.claims.gameId,
        value: sql<number>`count(*)`,
      })
      .from(schema.claims)
      .where(
        and(
          inArray(schema.claims.gameId, gameIds),
          eq(schema.claims.status, "open"),
        ),
      )
      .groupBy(schema.claims.gameId)
      .all()
      .map((row) => [row.gameId, num(row.value)] as const),
  );
  return { pots, opens };
}

export function adminGames(
  deps: AdminReadDeps,
  input: {
    readonly status?: string;
    readonly q?: string;
    readonly page: number;
  },
) {
  const conditions = [];
  if (input.status !== undefined)
    conditions.push(
      eq(
        schema.games.status,
        input.status as typeof schema.games.$inferSelect.status,
      ),
    );
  if (input.q !== undefined && input.q.length > 0) {
    const query = `%${input.q}%`;
    conditions.push(
      or(
        like(schema.games.id, query),
        like(schema.games.name, query),
      ) as NonNullable<ReturnType<typeof or>>,
    );
  }
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const total = num(
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.games)
      .where(where)
      .get()?.value,
  );
  const games = deps.db
    .select()
    .from(schema.games)
    .where(where)
    .orderBy(desc(schema.games.createdAt), asc(schema.games.id))
    .limit(PAGE_SIZE)
    .offset(offsetOf(input.page))
    .all();
  const { pots, opens } = gameAggregates(
    deps.db,
    games.map((game) => game.id),
  );
  return paged(
    games.map((game) =>
      gameCard(game, pots.get(game.id) ?? 0, opens.get(game.id) ?? 0),
    ),
    input.page,
    total,
  );
}

export function adminPlayers(
  deps: AdminReadDeps,
  input: {
    readonly kind?: "human" | "agent";
    readonly q?: string;
    readonly page: number;
  },
) {
  const conditions = [
    inArray(schema.players.kind, ["human", "agent"] as const),
  ];
  if (input.kind !== undefined) {
    conditions.push(eq(schema.players.kind, input.kind));
  }
  if (input.q !== undefined && input.q.length > 0) {
    const query = `%${input.q}%`;
    conditions.push(
      or(
        like(schema.players.address, query),
        like(schema.players.nickname, query),
      ) as NonNullable<ReturnType<typeof or>>,
    );
  }

  const where = and(...conditions);
  const total = num(
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.players)
      .where(where)
      .get()?.value,
  );

  // lastActive drives the sort order, so it has to be a grouped subquery over
  // claims rather than a page-scoped lookup — SQLite aggregates it without
  // handing any claim row back to JS.
  const activity = deps.db
    .select({
      player: schema.claims.player,
      at: sql<number>`max(max(${schema.claims.createdAt}, coalesce(${schema.claims.movedAt}, ${schema.claims.createdAt})))`.as(
        "at",
      ),
    })
    .from(schema.claims)
    .groupBy(schema.claims.player)
    .as("activity");
  const lastActiveAt = sql<number>`coalesce(${activity.at}, ${schema.players.createdAt})`;
  const playerRows = deps.db
    .select({ player: schema.players, lastActiveAt })
    .from(schema.players)
    .leftJoin(activity, eq(activity.player, schema.players.address))
    .where(where)
    .orderBy(
      desc(lastActiveAt),
      desc(schema.players.createdAt),
      asc(schema.players.address),
    )
    .limit(PAGE_SIZE)
    .offset(offsetOf(input.page))
    .all();

  const addresses = playerRows.map((row) => row.player.address);
  const pnl = new Map(
    addresses.length === 0
      ? []
      : deps.db
          .select({
            player: schema.stakeEntries.player,
            value: sql<number>`sum(coalesce(${schema.stakeEntries.payoutAmount}, 0) - ${schema.stakeEntries.amount})`,
          })
          .from(schema.stakeEntries)
          .where(inArray(schema.stakeEntries.player, addresses))
          .groupBy(schema.stakeEntries.player)
          .all()
          .map((row) => [row.player, num(row.value)] as const),
  );

  const rows = playerRows.map(({ player, lastActiveAt: activeAt }) => {
    const total = player.wins + player.draws + player.losses;
    return {
      address: player.address,
      nickname: player.nickname,
      kind: player.kind as "human" | "agent",
      createdAt: new Date(player.createdAt).toISOString(),
      lastActiveAt: new Date(num(activeAt)).toISOString(),
      banned: player.banned,
      deprioritizedUntil: iso(player.deprioritizedUntil),
      abandonCount: player.abandonCount,
      points: player.points,
      stats: {
        moves: total,
        wins: player.wins,
        draws: player.draws,
        losses: player.losses,
        winratePct: winratePct(player.wins, player.losses),
      },
      netPnlMicroUsdc: pnl.get(player.address) ?? 0,
    };
  });
  return paged(rows, input.page, total);
}

export function adminGame(deps: AdminReadDeps, gameId: string) {
  const game = deps.db
    .select()
    .from(schema.games)
    .where(eq(schema.games.id, gameId))
    .get();
  if (game === undefined) return null;
  const claims = deps.db
    .select({
      claim: schema.claims,
      nickname: schema.players.nickname,
    })
    .from(schema.claims)
    .leftJoin(schema.players, eq(schema.players.address, schema.claims.player))
    .where(eq(schema.claims.gameId, gameId))
    .orderBy(schema.claims.createdAt)
    .all()
    .map(({ claim, nickname }) => claimSummary(claim, nickname));
  const stakeRows = deps.db
    .select()
    .from(schema.stakeEntries)
    .where(eq(schema.stakeEntries.gameId, gameId))
    .all();
  const stakes = stakeRows.map((entry) => ({
    id: entry.id,
    player: entry.player,
    side: entry.side,
    kind: entry.kind,
    amountMicroUsdc: entry.amount,
    payTxid: entry.payTxid,
    ply: entry.ply,
  }));
  const payoutJobs = deps.db
    .select()
    .from(schema.payoutJobs)
    .where(eq(schema.payoutJobs.gameId, gameId))
    .all()
    .map((job) => ({
      id: job.id,
      recipient: job.recipient,
      amountMicroUsdc: job.amount,
      status: job.status,
      txid: job.txid,
      attempts: job.attempts,
    }));
  const payoutAmount = stakeRows.reduce(
    (sum, entry) => sum + (entry.payoutAmount ?? 0),
    0,
  );
  const takeRows = deps.db
    .select()
    .from(schema.ledger)
    .where(
      and(
        eq(schema.ledger.refId, gameId),
        inArray(schema.ledger.refType, ["fee", "dust", "surplus"]),
        eq(schema.ledger.account, "protocol"),
      ),
    )
    .all();
  const take = (kind: "fee" | "dust" | "surplus") =>
    takeRows
      .filter((entry) => entry.refType === kind)
      .reduce((sum, entry) => sum + entry.deltaMicrousdc, 0);
  const pot = stakes.reduce((sum, entry) => sum + entry.amountMicroUsdc, 0);
  const replay =
    game.replayJson === null
      ? null
      : (JSON.parse(game.replayJson) as { readonly pgn?: string });
  const fee = take("fee");
  const dust = take("dust");
  const surplus = take("surplus");
  return {
    game: {
      ...gameSummary(deps.db, game),
      fen: game.fen,
      pgn: replay?.pgn ?? "",
      termination: game.termination,
      endspielPly: game.endspielPly,
      rules: JSON.parse(game.rulesJson),
    },
    claims,
    stakes,
    resolution:
      game.resolvedAt === null
        ? null
        : {
            payoutsMicroUsdc: payoutAmount,
            feeMicroUsdc: fee,
            dustMicroUsdc: dust,
            surplusMicroUsdc: surplus,
            conserved: payoutAmount + fee + dust + surplus === pot,
          },
    payoutJobs,
  };
}

export function adminPlayer(deps: AdminReadDeps, address: string) {
  const player = deps.db
    .select()
    .from(schema.players)
    .where(eq(schema.players.address, address))
    .get();
  if (player === undefined) return null;
  const stakes = deps.db
    .select()
    .from(schema.stakeEntries)
    .where(eq(schema.stakeEntries.player, address))
    .all();
  const now = deps.now();
  // Only the last hour matters for the quota, so the window is a predicate
  // rather than a full per-player claim scan.
  const quotaClaims = (demo: boolean) =>
    deps.db
      .select({ createdAt: schema.claims.createdAt })
      .from(schema.claims)
      .where(
        and(
          eq(schema.claims.player, address),
          eq(schema.claims.demo, demo),
          gte(schema.claims.createdAt, now - HOUR_MS + 1),
        ),
      )
      .orderBy(asc(schema.claims.createdAt))
      .all();
  const quota = (
    claims: readonly { readonly createdAt: number }[],
    limit: number | null,
  ) => {
    if (limit === null) return { limit: null, remaining: null, resetsAt: null };
    const inWindow = claims.map((claim) => claim.createdAt);
    return {
      limit,
      remaining: Math.max(0, limit - inWindow.length),
      resetsAt:
        inWindow.length === 0
          ? null
          : new Date((inWindow[0] as number) + HOUR_MS).toISOString(),
    };
  };
  const total = player.wins + player.draws + player.losses;
  const recentClaims = deps.db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.player, address))
    .orderBy(desc(schema.claims.createdAt))
    .limit(25)
    .all()
    .map((claim) => claimSummary(claim, player.nickname));
  const stakedLimit =
    player.quotaOverride ??
    (player.kind === "agent" ? deps.config().QUOTA_AGENT : null);
  return {
    address: player.address,
    nickname: player.nickname,
    kind: player.kind,
    banned: player.banned,
    quotaOverride: player.quotaOverride,
    abandonCount: player.abandonCount,
    deprioritizedUntil: iso(player.deprioritizedUntil),
    stats: {
      moves: total,
      wins: player.wins,
      draws: player.draws,
      losses: player.losses,
      winratePct: winratePct(player.wins, player.losses),
    },
    netPnlMicroUsdc: stakes.reduce(
      (sum, entry) => sum + (entry.payoutAmount ?? 0) - entry.amount,
      0,
    ),
    ...(player.kind === "human"
      ? {
          points: player.points,
          referredBy: player.referredBy,
          referrals: {
            joined: player.refJoined,
            qualified: player.refQualified,
          },
        }
      : {}),
    quota: {
      staked: quota(quotaClaims(false), stakedLimit),
      demo: quota(quotaClaims(true), deps.config().QUOTA_DEMO),
    },
    recentClaims,
  };
}

export function adminErrors(
  deps: AdminReadDeps,
  input: {
    readonly level?: string;
    readonly code?: string;
    readonly page: number;
  },
) {
  const conditions = [];
  if (input.level !== undefined)
    conditions.push(eq(schema.errorLog.level, input.level));
  if (input.code !== undefined)
    conditions.push(eq(schema.errorLog.code, input.code));
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const total = num(
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(schema.errorLog)
      .where(where)
      .get()?.value,
  );
  const rows = deps.db
    .select()
    .from(schema.errorLog)
    .where(where)
    .orderBy(desc(schema.errorLog.id))
    .limit(PAGE_SIZE)
    .offset(offsetOf(input.page))
    .all()
    .map((row) => ({
      id: row.id,
      at: new Date(row.ts).toISOString(),
      level: row.level,
      code: row.code,
      requestId: row.requestId,
      context: sanitizeOperationalPayload(
        JSON.parse(row.contextJson),
        deps.secrets,
      ),
    }));
  return paged(rows, input.page, total);
}

export function adminConfig(deps: AdminReadDeps) {
  const current = deps.config();
  const state = deps.db.select().from(schema.systemState).get();
  const overrides = new Map(
    deps.db
      .select()
      .from(schema.configOverrides)
      .all()
      .map((row) => [row.key, row]),
  );
  return {
    revision: state?.configRevision ?? 0,
    items: Object.keys(current)
      .sort()
      .map((key) => {
        const typedKey = key as keyof ServerConfig;
        const override = overrides.get(key);
        return {
          key,
          defaultValue: deps.baseConfig[typedKey],
          overrideValue:
            override === undefined ? null : JSON.parse(override.valueJson),
          effectiveValue: current[typedKey],
          description: configDescription(typedKey),
          effect: configEffect(typedKey),
          editable: configEditable(typedKey),
          updatedAt: iso(override?.updatedAt ?? null),
          updatedBy: override?.updatedBy ?? null,
        };
      }),
    history: deps.db
      .select()
      .from(schema.auditLog)
      .where(like(schema.auditLog.action, "config.%"))
      .orderBy(desc(schema.auditLog.id))
      .limit(100)
      .all()
      .map((row) => ({
        id: row.id,
        at: new Date(row.ts).toISOString(),
        actor: row.actor,
        action: row.action,
        payload: JSON.parse(row.payloadJson),
      })),
  };
}

export function adminBonuses(deps: AdminReadDeps, pageNumber: number) {
  const now = deps.now();
  const today = new Date(now);
  const dayStart = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  // Every count keeps the inner join to players, so a starter stake whose
  // player row is gone stays excluded exactly as it was before.
  const claimedCount = (where?: SQL) =>
    num(
      deps.db
        .select({ value: sql<number>`count(*)` })
        .from(schema.bonuses)
        .innerJoin(
          schema.players,
          eq(schema.players.address, schema.bonuses.player),
        )
        .where(where)
        .get()?.value,
    );
  const totalClaimed = claimedCount();
  const todayClaimed = claimedCount(
    and(
      gte(schema.bonuses.claimedAt, dayStart),
      lte(schema.bonuses.claimedAt, dayStart + 86_400_000 - 1),
    ),
  );
  const bonusRows = deps.db
    .select({ bonus: schema.bonuses, player: schema.players })
    .from(schema.bonuses)
    .innerJoin(
      schema.players,
      eq(schema.players.address, schema.bonuses.player),
    )
    .orderBy(desc(schema.bonuses.claimedAt), asc(schema.bonuses.player))
    .limit(PAGE_SIZE)
    .offset(offsetOf(pageNumber))
    .all();
  const legTotals = new Map(
    deps.db
      .select({
        leg: schema.fundingJobs.leg,
        value: sql<number>`coalesce(sum(${schema.fundingJobs.amount}), 0)`,
      })
      .from(schema.fundingJobs)
      .where(eq(schema.fundingJobs.status, "confirmed"))
      .groupBy(schema.fundingJobs.leg)
      .all()
      .map((row) => [row.leg, num(row.value)] as const),
  );
  const pageAddresses = bonusRows.map(({ bonus }) => bonus.player);
  const stakedMoves = new Map(
    pageAddresses.length === 0
      ? []
      : deps.db
          .select({
            player: schema.stakeEntries.player,
            count: sql<number>`count(*)`,
          })
          .from(schema.stakeEntries)
          .where(inArray(schema.stakeEntries.player, pageAddresses))
          .groupBy(schema.stakeEntries.player)
          .all()
          .map((row) => [row.player, num(row.count)] as const),
  );
  const items = bonusRows.map(({ bonus, player }) => ({
    address: bonus.player,
    nickname: player.nickname,
    status: bonus.status,
    claimIp: bonus.claimIp,
    claimedAt: new Date(bonus.claimedAt).toISOString(),
    fundedAt: iso(bonus.fundedAt),
    algoTxid: bonus.algoTxid,
    usdcTxid: bonus.usdcTxid,
    lifetimeStakedMoves: stakedMoves.get(bonus.player) ?? 0,
    points: player.points,
    referredBy: player.referredBy,
  }));
  return {
    todayClaimed,
    dailyCap: deps.config().BONUS_DAILY_CAP,
    totalClaimed,
    totalAlgoMicro: legTotals.get("algo") ?? 0,
    totalUsdcMicro: legTotals.get("usdc") ?? 0,
    ...paged(items, pageNumber, totalClaimed),
  };
}
