import type { PaymentRail } from "@onestepchess/core";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
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
import { configEditable, configEffect } from "./config-metadata.js";

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

function page<T>(items: readonly T[], pageNumber: number, size = PAGE_SIZE) {
  const total = items.length;
  const pageCount = total === 0 ? 0 : Math.ceil(total / size);
  return {
    items: items.slice((pageNumber - 1) * size, pageNumber * size),
    page: pageNumber,
    pageCount,
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
    payouts,
    funding: { pending: 0, prepared: 0, submitted: 0, failed: 0 },
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

export function adminActivity(deps: AdminReadDeps, window: ActivityWindow) {
  const now = deps.now();
  const from = windowStart(window, now);
  const inside = (at: number | null) =>
    at !== null && (from === null || at >= from) && at <= now;
  const players = deps.db.select().from(schema.players).all();
  const playerByAddress = new Map(
    players.map((player) => [player.address, player]),
  );
  const allClaims = deps.db.select().from(schema.claims).all();
  const claims = allClaims.filter((claim) => inside(claim.createdAt));
  const moved = allClaims.filter(
    (claim) => claim.status === "moved" && inside(claim.movedAt),
  );
  const stakedMoved = moved.filter((claim) => !claim.demo);
  const humanStaked = stakedMoved.filter(
    (claim) => playerByAddress.get(claim.player)?.kind === "human",
  );
  const agentStaked = stakedMoved.filter(
    (claim) => playerByAddress.get(claim.player)?.kind === "agent",
  );
  const humanAddresses = new Set(humanStaked.map((claim) => claim.player));
  const agentAddresses = new Set(agentStaked.map((claim) => claim.player));
  const demoHumanAddresses = new Set(
    moved
      .filter((claim) => claim.demo)
      .map((claim) => claim.player)
      .filter((address) => playerByAddress.get(address)?.kind === "human"),
  );
  const demoAddresses = new Set(
    [...demoHumanAddresses].filter((address) => !humanAddresses.has(address)),
  );
  const games = deps.db
    .select()
    .from(schema.games)
    .all()
    .filter((game) => inside(game.finishedAt));
  const allStakes = deps.db.select().from(schema.stakeEntries).all();
  const stakes = allStakes.filter((entry) => inside(entry.createdAt));
  const payoutJobs = deps.db
    .select()
    .from(schema.payoutJobs)
    .all()
    .filter((job) => job.status === "confirmed" && inside(job.createdAt));
  const ledger = deps.db
    .select()
    .from(schema.ledger)
    .all()
    .filter((entry) => inside(entry.ts));
  const humanClaims = claims.filter(
    (claim) => playerByAddress.get(claim.player)?.kind !== "agent",
  );
  const agentClaims = claims.filter(
    (claim) => playerByAddress.get(claim.player)?.kind === "agent",
  );
  const humanLatencies = humanClaims
    .filter((claim) => claim.movedAt !== null)
    .map((claim) => ((claim.movedAt as number) - claim.createdAt) / 1_000);

  const resolvedGames = new Set(
    deps.db
      .select({ id: schema.games.id, resolvedAt: schema.games.resolvedAt })
      .from(schema.games)
      .all()
      .filter((game) => inside(game.resolvedAt))
      .map((game) => game.id),
  );
  const pnl = new Map<string, number>();
  for (const entry of allStakes.filter((item) =>
    resolvedGames.has(item.gameId),
  )) {
    if (entry.payoutAmount === null) continue;
    pnl.set(
      entry.player,
      (pnl.get(entry.player) ?? 0) + entry.payoutAmount - entry.amount,
    );
  }
  const ranked = [...pnl]
    .map(([address, pnlMicroUsdc]) => ({
      address,
      nickname: playerByAddress.get(address)?.nickname ?? "",
      pnlMicroUsdc,
    }))
    .sort(
      (a, b) =>
        b.pnlMicroUsdc - a.pnlMicroUsdc || a.address.localeCompare(b.address),
    );

  return {
    window,
    fromAt: iso(from),
    toAt: new Date(now).toISOString(),
    counts: {
      activeHumans: humanAddresses.size,
      activeAgents: agentAddresses.size,
      demoOnlyPlayers: demoAddresses.size,
      registrations: players.filter(
        (player) => player.kind !== "guest" && inside(player.createdAt),
      ).length,
      humanMoves: humanStaked.length,
      agentMoves: agentStaked.length,
      demoMoves: moved.filter((claim) => claim.demo).length,
      claimsCreated: claims.length,
      claimsMoved: moved.length,
      claimsExpired: claims.filter((claim) => claim.status === "expired")
        .length,
      gamesFinished: games.length,
    },
    money: {
      stakeVolumeMicroUsdc: stakes.reduce(
        (sum, entry) => sum + entry.amount,
        0,
      ),
      payoutVolumeMicroUsdc: payoutJobs.reduce(
        (sum, job) => sum + job.amount,
        0,
      ),
      protocolTakeMicroUsdc: ledger
        .filter((entry) => entry.account === "protocol")
        .reduce((sum, entry) => sum + entry.deltaMicrousdc, 0),
      treasuryNetFlowMicroUsdc: ledger
        .filter((entry) => entry.account === "treasury")
        .reduce((sum, entry) => sum + entry.deltaMicrousdc, 0),
    },
    tripwires: {
      claimMovePctHuman: pct(
        humanClaims.filter((claim) => claim.status === "moved").length,
        humanClaims.length,
      ),
      claimMovePctAgent: pct(
        agentClaims.filter((claim) => claim.status === "moved").length,
        agentClaims.length,
      ),
      demoSharePct: pct(
        moved.filter((claim) => claim.demo).length,
        moved.length,
      ),
      demoToStakedPct: pct(
        [...demoHumanAddresses].filter((address) => humanAddresses.has(address))
          .length,
        demoHumanAddresses.size,
      ),
      humanMoveLatencyP50Seconds: percentile(humanLatencies, 50),
      humanMoveLatencyP95Seconds: percentile(humanLatencies, 95),
      quotaSaturationPct: null,
      topWinners: ranked.filter((item) => item.pnlMicroUsdc > 0).slice(0, 5),
      topLosers: ranked
        .filter((item) => item.pnlMicroUsdc < 0)
        .sort((a, b) => a.pnlMicroUsdc - b.pnlMicroUsdc)
        .slice(0, 5),
    },
  };
}

function gameSummary(db: Db, game: typeof schema.games.$inferSelect) {
  const stakePotMicroUsdc = Number(
    db
      .select({
        value: sql<number>`coalesce(sum(${schema.stakeEntries.amount}), 0)`,
      })
      .from(schema.stakeEntries)
      .where(eq(schema.stakeEntries.gameId, game.id))
      .get()?.value ?? 0,
  );
  const claimsOpen = Number(
    db
      .select({ value: sql<number>`count(*)` })
      .from(schema.claims)
      .where(
        and(
          eq(schema.claims.gameId, game.id),
          eq(schema.claims.status, "open"),
        ),
      )
      .get()?.value ?? 0,
  );
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
  const rows = deps.db
    .select()
    .from(schema.games)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(schema.games.createdAt))
    .all()
    .map((game) => gameSummary(deps.db, game));
  return page(rows, input.page);
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
  const stakedClaims = deps.db
    .select()
    .from(schema.claims)
    .where(
      and(eq(schema.claims.player, address), eq(schema.claims.demo, false)),
    )
    .all();
  const demoClaims = deps.db
    .select()
    .from(schema.claims)
    .where(and(eq(schema.claims.player, address), eq(schema.claims.demo, true)))
    .all();
  const quota = (
    claims: readonly (typeof schema.claims.$inferSelect)[],
    limit: number,
  ) => {
    const inWindow = claims
      .map((claim) => claim.createdAt)
      .filter((at) => at > now - HOUR_MS)
      .sort((a, b) => a - b);
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
    (player.kind === "agent"
      ? deps.config().QUOTA_AGENT
      : deps.config().QUOTA_HUMAN);
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
      winratePct: total === 0 ? null : (player.wins / total) * 100,
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
      staked: quota(stakedClaims, stakedLimit),
      demo: quota(demoClaims, deps.config().QUOTA_DEMO),
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
  const rows = deps.db
    .select()
    .from(schema.errorLog)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(schema.errorLog.id))
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
  return page(rows, input.page);
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
  return {
    todayClaimed: 0,
    dailyCap: deps.config().BONUS_DAILY_CAP,
    totalClaimed: 0,
    totalAlgoMicro: 0,
    totalUsdcMicro: 0,
    ...page([], pageNumber),
    available: false,
    reason: "Release 4 feature unavailable",
  };
}
