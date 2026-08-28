import type { PaymentRail, Rng } from "@onestepchess/core";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  freeNickname,
  NICKNAME_PATTERN,
  nicknameTaken,
} from "../../auth/nickname.js";
import {
  BONUS_SKIP_ALGO_MICRO,
  bonusProfileStatus,
  hasSufficientBalancesForStarterStake,
} from "../../bonuses/lifecycle.js";
import { CardCache } from "../../cards/raster.js";
import { buildCardSvg, type CardOutcome } from "../../cards/svg.js";
import type { Coordinator } from "../../coordinator/queue.js";
import { schema } from "../../db/open.js";
import { winratePct } from "../../player-stats.js";
import {
  findTerminalReplayGame,
  parseStoredReplay,
  repetitionAdjudicationFor,
} from "../../replays.js";
import { type AppEnv, AppError } from "../app.js";
import {
  cardQuerySchema,
  gamesQuerySchema,
  renameBodySchema,
} from "../contracts.js";
import { parseJsonBody, parseQuery } from "../validation.js";
import { playerView } from "../views.js";
import { type SessionAuthDeps, sessionAuth } from "./auth.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export type HumanRouteDeps = SessionAuthDeps & {
  readonly coordinator: Coordinator;
  readonly rail: PaymentRail;
  readonly trustProxyHops: number;
  readonly rng: Rng;
};

export function registerHumanCommands(deps: HumanRouteDeps): void {
  deps.coordinator.register(
    "ProfileRenamed",
    (ctx, payload: { player: string; nickname: string }) => {
      const player = deps.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, payload.player))
        .get();
      if (player === undefined || player.kind === "guest")
        return { status: "missing" as const };
      if (player.nickname === payload.nickname)
        return { status: "ok" as const, player };
      if (nicknameTaken(deps.db, payload.nickname, payload.player))
        return { status: "taken" as const };
      const changes = deps.db
        .select({ changedAt: schema.nicknameChanges.changedAt })
        .from(schema.nicknameChanges)
        .where(
          and(
            eq(schema.nicknameChanges.player, payload.player),
            gt(schema.nicknameChanges.changedAt, ctx.now - DAY_MS),
          ),
        )
        .orderBy(schema.nicknameChanges.changedAt)
        .all();
      if (changes.length >= deps.config().NICKNAME_CHANGES_PER_DAY) {
        const oldest = changes[0];
        if (oldest === undefined) throw new Error("rename window missing");
        return {
          status: "limited" as const,
          retryAfterSeconds: Math.ceil(
            (oldest.changedAt + DAY_MS - ctx.now) / 1_000,
          ),
        };
      }
      deps.db
        .update(schema.players)
        .set({ nickname: payload.nickname })
        .where(eq(schema.players.address, payload.player))
        .run();
      deps.db
        .insert(schema.nicknameChanges)
        .values({ player: payload.player, changedAt: ctx.now })
        .run();
      return {
        status: "ok" as const,
        player: { ...player, nickname: payload.nickname },
      };
    },
  );
}

function quotaView(
  deps: HumanRouteDeps,
  player: string,
  demo: boolean,
  limit: number | null,
) {
  // limit === null means uncapped — staked human claims have no hourly quota.
  if (limit === null) return { limit: null, remaining: null, resetsAt: null };
  const now = deps.now();
  const rows = deps.db
    .select({ createdAt: schema.claims.createdAt })
    .from(schema.claims)
    .where(
      and(
        eq(schema.claims.player, player),
        eq(schema.claims.demo, demo),
        gt(schema.claims.createdAt, now - HOUR_MS),
      ),
    )
    .orderBy(schema.claims.createdAt)
    .all();
  return {
    limit,
    remaining: Math.max(0, limit - rows.length),
    resetsAt:
      rows[0] === undefined
        ? null
        : new Date(rows[0].createdAt + HOUR_MS).toISOString(),
  };
}

export function registerHumanRoutes(
  app: Hono<AppEnv>,
  deps: HumanRouteDeps,
): void {
  const auth = sessionAuth(deps);
  const cardCache = new CardCache(deps.config().CARD_CACHE_MAX);

  app.get("/api/v1/my/profile", auth, async (c) => {
    const address = c.get("session").address;
    const player = deps.db
      .select()
      .from(schema.players)
      .where(eq(schema.players.address, address))
      .get();
    if (player === undefined) throw new Error("authenticated player missing");
    const include = c.req.query("include");
    if (include !== undefined && include !== "balances")
      throw new AppError("INVALID_REQUEST", { hint: "invalid include value" });
    const moves =
      deps.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.stakeEntries)
        .where(eq(schema.stakeEntries.player, address))
        .get()?.count ?? 0;
    const netPnlMicroUsdc =
      deps.db
        .select({
          value: sql<number>`coalesce(sum(${schema.stakeEntries.payoutAmount} - ${schema.stakeEntries.amount}), 0)`,
        })
        .from(schema.stakeEntries)
        .where(
          and(
            eq(schema.stakeEntries.player, address),
            sql`${schema.stakeEntries.payoutAmount} is not null`,
          ),
        )
        .get()?.value ?? 0;
    const stakedLimit =
      player.quotaOverride ??
      (player.kind === "agent" ? deps.config().QUOTA_AGENT : null);
    const balances =
      include === "balances" ? await deps.rail.getBalances(address) : undefined;
    // Points and referral fields are humans-only (F15) — absent for agents.
    let bonus =
      player.kind === "human"
        ? bonusProfileStatus(deps, address, deps.now())
        : null;
    if (
      bonus?.status === "available" ||
      (bonus?.status === "claimed" && bonus.algoTxid === undefined)
    ) {
      try {
        const eligibilityBalances =
          balances ?? (await deps.rail.getBalances(address));
        if (
          bonus.status === "available" &&
          hasSufficientBalancesForStarterStake(eligibilityBalances)
        ) {
          bonus = null;
        } else if (
          bonus.status === "claimed" &&
          eligibilityBalances.algoMicroAlgo >= BONUS_SKIP_ALGO_MICRO
        ) {
          bonus = { ...bonus, algoReady: true };
        }
      } catch {
        // A transient chain read must not permanently hide an otherwise
        // eligible starter stake; the claim route repeats the guard.
      }
    }
    const incentives =
      player.kind === "human"
        ? {
            points: player.points,
            refCode: player.refCode,
            referrals: {
              joined: player.refJoined,
              qualified: player.refQualified,
            },
            ...(bonus === null ? {} : { bonus }),
          }
        : {};
    return c.json({
      ...playerView(player),
      stats: {
        moves,
        wins: player.wins,
        draws: player.draws,
        losses: player.losses,
        winratePct: winratePct(player.wins, player.losses),
      },
      netPnlMicroUsdc,
      ...(balances === undefined ? {} : { balances }),
      quotas: {
        staked: quotaView(deps, address, false, stakedLimit),
        demo: quotaView(deps, address, true, deps.config().QUOTA_DEMO),
      },
      deprioritizedUntil:
        player.deprioritizedUntil === null
          ? null
          : new Date(player.deprioritizedUntil).toISOString(),
      ...incentives,
    });
  });

  app.patch("/api/v1/my/profile", auth, async (c) => {
    const body = await parseJsonBody(
      renameBodySchema,
      c.req,
      "nickname is required",
    );
    if (!NICKNAME_PATTERN.test(body.nickname))
      throw new AppError("INVALID_NICKNAME", {
        hint: "nickname must match ^[a-zA-Z0-9_-]{3,24}$",
      });
    const result = await deps.coordinator.dispatch<
      { player: string; nickname: string },
      | { status: "missing" | "taken" }
      | { status: "limited"; retryAfterSeconds: number }
      | { status: "ok"; player: typeof schema.players.$inferSelect }
    >({
      type: "ProfileRenamed",
      payload: {
        player: c.get("session").address,
        nickname: body.nickname,
      },
    });
    if (result.kind !== "ok") throw new Error("rename deprioritized");
    if (result.result.status === "taken")
      throw new AppError("NICKNAME_TAKEN", {
        hint: "nickname already in use",
        suggestion: freeNickname(deps.db, deps.rng),
      });
    if (result.result.status === "limited")
      throw new AppError("RENAME_RATE_LIMITED", {
        hint: "nickname change limit reached",
        retryAfterSeconds: result.result.retryAfterSeconds,
      });
    if (result.result.status !== "ok")
      throw new AppError("UNAUTHENTICATED", { hint: "unknown player" });
    return c.json({ player: playerView(result.result.player) });
  });

  app.get("/api/v1/my/games", auth, (c) => {
    const query = parseQuery(gamesQuerySchema, {
      status: c.req.query("status"),
      page: c.req.query("page") ?? 1,
    });
    const address = c.get("session").address;
    const stakeEntriesFor = (claimIds: readonly string[]) =>
      new Map(
        (claimIds.length === 0
          ? []
          : deps.db
              .select()
              .from(schema.stakeEntries)
              .where(inArray(schema.stakeEntries.claimId, [...claimIds]))
              .all()
        ).map((entry) => [entry.claimId, entry]),
      );

    if (query.status === "ongoing") {
      const pageSize = deps.config().PAGE_SIZE_ACTIVE;
      // The games join exists only to evaluate the status filter — every
      // response field is a claim column, so no games column is selected and
      // the probe never touches a game row's blob overflow pages (G1, spec
      // 2026-08-28).
      const predicate = and(
        eq(schema.claims.player, address),
        eq(schema.claims.status, "moved"),
        inArray(schema.games.status, ["active", "endspiel"]),
      );
      const claimRows = deps.db
        .select({
          id: schema.claims.id,
          side: schema.claims.side,
          demo: schema.claims.demo,
          stakeMicrousdc: schema.claims.stakeMicrousdc,
          createdAt: schema.claims.createdAt,
          movedAt: schema.claims.movedAt,
          moveUci: schema.claims.moveUci,
          moveSan: schema.claims.moveSan,
          fenBefore: schema.claims.fenBefore,
        })
        .from(schema.claims)
        .innerJoin(schema.games, eq(schema.games.id, schema.claims.gameId))
        .where(predicate)
        .orderBy(desc(schema.claims.movedAt), desc(schema.claims.id))
        .limit(pageSize)
        .offset((query.page - 1) * pageSize)
        .all();
      const total =
        deps.db
          .select({ count: sql<number>`count(*)` })
          .from(schema.claims)
          .innerJoin(schema.games, eq(schema.games.id, schema.claims.gameId))
          .where(predicate)
          .get()?.count ?? 0;
      const entryByClaim = stakeEntriesFor(claimRows.map((claim) => claim.id));
      const items = claimRows.map((claim) => {
        if (
          claim.moveUci === null ||
          claim.moveSan === null ||
          claim.movedAt === null ||
          claim.fenBefore === null
        )
          throw new Error(`moved claim ${claim.id} lacks move data`);
        return {
          yourMove: { uci: claim.moveUci, san: claim.moveSan },
          yourSide: claim.side,
          demo: claim.demo,
          stakeMicroUsdc: claim.stakeMicrousdc,
          claimedAt: new Date(claim.createdAt).toISOString(),
          movedAt: new Date(claim.movedAt).toISOString(),
          fenBeforeYourMove: claim.fenBefore,
          payTxid: entryByClaim.get(claim.id)?.payTxid ?? null,
        };
      });
      return c.json({
        items,
        page: query.page,
        pageCount: Math.ceil(total / pageSize),
        total,
      });
    }

    const pageSize = deps.config().PAGE_SIZE_FINISHED;
    const predicate = and(
      eq(schema.claims.player, address),
      eq(schema.claims.status, "moved"),
      inArray(schema.games.status, ["finished", "aborted"]),
    );
    // The page unit is the game, so paging happens over grouped game rows;
    // ties on finished_at are pinned by game id to make the order canonical
    // instead of an accident of index traversal (G1, spec 2026-08-28).
    const gameRows = deps.db
      .select({
        id: schema.games.id,
        name: schema.games.name,
        fen: schema.games.fen,
        result: schema.games.result,
        termination: schema.games.termination,
        rulesJson: schema.games.rulesJson,
        createdAt: schema.games.createdAt,
        finishedAt: schema.games.finishedAt,
      })
      .from(schema.claims)
      .innerJoin(schema.games, eq(schema.games.id, schema.claims.gameId))
      .where(predicate)
      .groupBy(schema.games.id)
      .orderBy(sql`max(${schema.games.finishedAt}) desc`, asc(schema.games.id))
      .limit(pageSize)
      .offset((query.page - 1) * pageSize)
      .all();
    const total =
      deps.db
        .select({ count: sql<number>`count(distinct ${schema.games.id})` })
        .from(schema.claims)
        .innerJoin(schema.games, eq(schema.games.id, schema.claims.gameId))
        .where(predicate)
        .get()?.count ?? 0;
    const gameIds = gameRows.map((game) => game.id);
    const claimRows =
      gameIds.length === 0
        ? []
        : deps.db
            .select({
              id: schema.claims.id,
              gameId: schema.claims.gameId,
              side: schema.claims.side,
              demo: schema.claims.demo,
              stakeMicrousdc: schema.claims.stakeMicrousdc,
              createdAt: schema.claims.createdAt,
              movedAt: schema.claims.movedAt,
              movedPly: schema.claims.movedPly,
              moveUci: schema.claims.moveUci,
              moveSan: schema.claims.moveSan,
              fenBefore: schema.claims.fenBefore,
            })
            .from(schema.claims)
            .where(
              and(
                eq(schema.claims.player, address),
                eq(schema.claims.status, "moved"),
                inArray(schema.claims.gameId, gameIds),
              ),
            )
            .orderBy(asc(schema.claims.movedAt), asc(schema.claims.id))
            .all();
    const claimsByGame = new Map<string, (typeof claimRows)[number][]>();
    for (const claim of claimRows) {
      const group = claimsByGame.get(claim.gameId) ?? [];
      group.push(claim);
      claimsByGame.set(claim.gameId, group);
    }
    const entryByClaim = stakeEntriesFor(claimRows.map((claim) => claim.id));
    const jobs =
      gameIds.length === 0
        ? []
        : deps.db
            .select()
            .from(schema.payoutJobs)
            .where(
              and(
                inArray(schema.payoutJobs.gameId, gameIds),
                eq(schema.payoutJobs.recipient, address),
              ),
            )
            .all();
    const jobByGame = new Map(jobs.map((job) => [job.gameId, job]));
    // Group order must come from the paged game rows — the claims query
    // returns index order, which can disagree with game recency (G1).
    const items = gameRows.map((game) => {
      const group = claimsByGame.get(game.id);
      const first = group?.[0];
      if (group === undefined || first === undefined)
        throw new Error("empty participation group");
      for (const claim of group) {
        if (
          claim.moveUci === null ||
          claim.moveSan === null ||
          claim.movedAt === null ||
          claim.fenBefore === null
        )
          throw new Error(`moved claim ${claim.id} lacks move data`);
      }
      if (
        game.result === null ||
        game.termination === null ||
        game.finishedAt === null
      )
        throw new Error(`terminal game ${game.id} lacks result data`);
      const ordered = [...group].sort(
        (a, b) =>
          (a.movedPly ?? Number.MAX_SAFE_INTEGER) -
          (b.movedPly ?? Number.MAX_SAFE_INTEGER),
      );
      const thinkingTimeMs = ordered.reduce(
        (totalMs, claim) =>
          totalMs + Math.max(0, (claim.movedAt as number) - claim.createdAt),
        0,
      );
      const stakeMicroUsdc = ordered.reduce(
        (totalStake, claim) => totalStake + claim.stakeMicrousdc,
        0,
      );
      const finishedCommon = {
        yourSide: first.side,
        stakeMicroUsdc,
        thinkingTimeMs,
        startedAt: new Date(game.createdAt).toISOString(),
        result: game.result,
        termination: game.termination,
        repetitionAdjudication: repetitionAdjudicationFor(game),
        finishedAt: new Date(game.finishedAt).toISOString(),
      };
      if (ordered.every((claim) => claim.demo))
        return {
          ...finishedCommon,
          yourMoves: ordered.map((claim) => ({
            uci: claim.moveUci as string,
            san: claim.moveSan as string,
          })),
          demo: true,
          payoutMicroUsdc: 0,
          payoutStatus: null,
          statsCounted: false,
        };
      for (const claim of ordered) {
        if (claim.movedPly === null)
          throw new Error(
            `staked game ${game.id} has a claim without moved ply`,
          );
        if (!claim.demo && entryByClaim.get(claim.id) === undefined)
          throw new Error(`staked claim ${claim.id} lacks entry data`);
      }
      const payout = ordered.reduce(
        (totalPayout, claim) =>
          totalPayout + (entryByClaim.get(claim.id)?.payoutAmount ?? 0),
        0,
      );
      const job = jobByGame.get(game.id);
      const payoutStatus =
        payout === 0
          ? "none"
          : job?.status === "confirmed"
            ? "confirmed"
            : job?.status === "failed"
              ? "failed"
              : "queued";
      return {
        ...finishedCommon,
        yourMoves: ordered.map((claim) => ({
          uci: claim.moveUci as string,
          san: claim.moveSan as string,
          ply: claim.movedPly as number,
        })),
        demo: false,
        gameId: game.id,
        gameName: game.name,
        finalFen: game.fen,
        payTxid:
          ordered.length === 1
            ? (entryByClaim.get(first.id)?.payTxid ?? null)
            : null,
        payoutMicroUsdc: payout,
        payoutTxid: job?.txid ?? null,
        payoutStatus,
        statsCounted: true,
      };
    });
    return c.json({
      items,
      page: query.page,
      pageCount: Math.ceil(total / pageSize),
      total,
    });
  });

  app.get("/api/v1/games/:id/replay", (c) => {
    const game = findTerminalReplayGame(deps.db, c.req.param("id"));
    if (
      game === null ||
      game.result === null ||
      game.termination === null ||
      game.finishedAt === null
    )
      throw new AppError("GAME_NOT_FOUND", { hint: "game not found" });
    const stored = parseStoredReplay(game.replayJson);
    const addresses = [
      ...new Set(stored.plies.map((ply) => ply.authorAddress)),
    ];
    const players =
      addresses.length === 0
        ? []
        : deps.db
            .select()
            .from(schema.players)
            .where(inArray(schema.players.address, addresses))
            .all();
    const playerByAddress = new Map(
      players.map((player) => [player.address, player]),
    );
    // Same "moves" definition as /my/profile: staked entries only.
    const movesByAddress = new Map(
      (addresses.length === 0
        ? []
        : deps.db
            .select({
              player: schema.stakeEntries.player,
              count: sql<number>`count(*)`,
            })
            .from(schema.stakeEntries)
            .where(inArray(schema.stakeEntries.player, addresses))
            .groupBy(schema.stakeEntries.player)
            .all()
      ).map((row) => [row.player, row.count]),
    );
    return c.json({
      gameId: game.id,
      name: game.name,
      result: game.result,
      termination: game.termination,
      repetitionAdjudication: repetitionAdjudicationFor(game),
      endspielPly: game.endspielPly,
      createdAt: new Date(game.createdAt).toISOString(),
      finishedAt: new Date(game.finishedAt).toISOString(),
      plies: stored.plies.map(({ authorAddress, ...ply }) => {
        const author = playerByAddress.get(authorAddress);
        if (author === undefined) throw new Error("replay author missing");
        return {
          ...ply,
          author: {
            nickname: author.nickname,
            kind: author.kind,
            winratePct: winratePct(author.wins, author.losses),
            movesTotal: movesByAddress.get(authorAddress) ?? 0,
          },
        };
      }),
      pgn: stored.pgn,
    });
  });

  app.get("/api/v1/games/:id/card.png", async (c) => {
    const game = findTerminalReplayGame(deps.db, c.req.param("id"));
    // I7 parity with the replay route: unknown and non-terminal ids are the
    // same GAME_NOT_FOUND, so a card never leaks a game's existence (F16).
    if (game === null || game.result === null)
      throw new AppError("GAME_NOT_FOUND", { hint: "game not found" });
    const stored = parseStoredReplay(game.replayJson);
    if (stored.plies.length === 0)
      throw new AppError("GAME_NOT_FOUND", { hint: "game not found" });
    let plyIndex = stored.plies.length;
    const query = parseQuery(cardQuerySchema, { ply: c.req.query("ply") });
    if (query.ply !== undefined) {
      if (query.ply > stored.plies.length)
        throw new AppError("INVALID_REQUEST", { hint: "ply out of range" });
      plyIndex = query.ply;
    }
    const ply = stored.plies[plyIndex - 1];
    if (ply === undefined)
      throw new AppError("INVALID_REQUEST", { hint: "ply out of range" });
    // Only the public nickname is rendered — the author address never leaves
    // the server (§6.3 replay scrub).
    const author = deps.db
      .select({ nickname: schema.players.nickname })
      .from(schema.players)
      .where(eq(schema.players.address, ply.authorAddress))
      .get();
    const outcome: CardOutcome =
      game.result === ply.side
        ? "WON"
        : game.result === "draw" || game.result === "aborted"
          ? "DRAW"
          : "LOST";
    // Author aggregates across all their moves in this game (Sergey's card
    // copy, 2026-08-20): summed thinking time and net USDC (payouts − stakes),
    // matching the /my/games multi-move totals.
    const authorClaims = deps.db
      .select()
      .from(schema.claims)
      .where(
        and(
          eq(schema.claims.gameId, game.id),
          eq(schema.claims.player, ply.authorAddress),
          eq(schema.claims.status, "moved"),
        ),
      )
      .all();
    const thinkingTimeMs = authorClaims.reduce(
      (total, claim) =>
        total +
        Math.max(0, (claim.movedAt ?? claim.createdAt) - claim.createdAt),
      0,
    );
    const stakeMicroUsdc = authorClaims.reduce(
      (total, claim) => total + claim.stakeMicrousdc,
      0,
    );
    const authorClaimIds = authorClaims.map((claim) => claim.id);
    const payoutMicroUsdc = (
      authorClaimIds.length === 0
        ? []
        : deps.db
            .select()
            .from(schema.stakeEntries)
            .where(inArray(schema.stakeEntries.claimId, authorClaimIds))
            .all()
    ).reduce((total, entry) => total + (entry.payoutAmount ?? 0), 0);
    const svg = buildCardSvg({
      gameId: game.id,
      authorNickname: author?.nickname ?? null,
      outcome,
      fen: ply.fenAfter,
      moveUci: ply.move.uci,
      thinkingTimeMs,
      wonMicroUsdc: payoutMicroUsdc - stakeMicroUsdc,
    });
    const png = await cardCache.render(`${game.id}:${plyIndex}`, svg);
    // Copy into a plain Uint8Array so the body type is exact (Hono rejects the
    // ArrayBufferLike-backed Node Buffer).
    return c.body(new Uint8Array(png), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    });
  });
}
