import type { PaymentRail, Rng } from "@onestepchess/core";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  freeNickname,
  NICKNAME_PATTERN,
  nicknameTaken,
} from "../../auth/nickname.js";
import { CardCache } from "../../cards/raster.js";
import { buildCardSvg, type CardOutcome } from "../../cards/svg.js";
import type { Coordinator } from "../../coordinator/queue.js";
import { schema } from "../../db/open.js";
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
  limit: number,
) {
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
    const decisions = player.wins + player.draws + player.losses;
    const stakedLimit =
      player.quotaOverride ??
      (player.kind === "agent"
        ? deps.config().QUOTA_AGENT
        : deps.config().QUOTA_HUMAN);
    const balances =
      include === "balances" ? await deps.rail.getBalances(address) : undefined;
    // Points and referral fields are humans-only (F15) — absent for agents.
    const incentives =
      player.kind === "human"
        ? {
            points: player.points,
            refCode: player.refCode,
            referrals: {
              joined: player.refJoined,
              qualified: player.refQualified,
            },
          }
        : {};
    return c.json({
      ...playerView(player),
      stats: {
        moves,
        wins: player.wins,
        draws: player.draws,
        losses: player.losses,
        winratePct: decisions === 0 ? null : (player.wins / decisions) * 100,
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
    const participations = deps.db
      .select({ claim: schema.claims, game: schema.games })
      .from(schema.claims)
      .innerJoin(schema.games, eq(schema.games.id, schema.claims.gameId))
      .where(
        and(
          eq(schema.claims.player, address),
          eq(schema.claims.status, "moved"),
        ),
      )
      .all()
      .filter(({ game }) =>
        query.status === "ongoing"
          ? game.status === "active" || game.status === "endspiel"
          : game.status === "finished" || game.status === "aborted",
      )
      .sort((a, b) =>
        query.status === "ongoing"
          ? (b.claim.movedAt ?? 0) - (a.claim.movedAt ?? 0)
          : (b.game.finishedAt ?? 0) - (a.game.finishedAt ?? 0),
      );
    const claimIds = participations.map(({ claim }) => claim.id);
    const entries =
      claimIds.length === 0
        ? []
        : deps.db
            .select()
            .from(schema.stakeEntries)
            .where(inArray(schema.stakeEntries.claimId, claimIds))
            .all();
    const entryByClaim = new Map(
      entries.map((entry) => [entry.claimId, entry]),
    );
    const gameIds = [...new Set(participations.map(({ game }) => game.id))];
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
    const groupedParticipations =
      query.status === "ongoing"
        ? participations.map((participation) => [participation])
        : [
            ...participations
              .reduce((byGame, participation) => {
                const group = byGame.get(participation.game.id) ?? [];
                group.push(participation);
                byGame.set(participation.game.id, group);
                return byGame;
              }, new Map<string, (typeof participations)[number][]>())
              .values(),
          ];
    const pageSize =
      query.status === "ongoing"
        ? deps.config().PAGE_SIZE_ACTIVE
        : deps.config().PAGE_SIZE_FINISHED;
    const total = groupedParticipations.length;
    const pageCount = Math.ceil(total / pageSize);
    const selected = groupedParticipations.slice(
      (query.page - 1) * pageSize,
      query.page * pageSize,
    );
    const items = selected.map((group) => {
      const first = group[0];
      if (first === undefined) throw new Error("empty participation group");
      const { claim, game } = first;
      for (const participation of group) {
        if (
          participation.claim.moveUci === null ||
          participation.claim.moveSan === null ||
          participation.claim.movedAt === null ||
          participation.claim.fenBefore === null
        )
          throw new Error(
            `moved claim ${participation.claim.id} lacks move data`,
          );
      }
      if (query.status === "ongoing") {
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
      }
      if (
        game.result === null ||
        game.termination === null ||
        game.finishedAt === null
      )
        throw new Error(`terminal game ${game.id} lacks result data`);
      const ordered = [...group].sort(
        (a, b) =>
          (a.claim.movedPly ?? Number.MAX_SAFE_INTEGER) -
          (b.claim.movedPly ?? Number.MAX_SAFE_INTEGER),
      );
      const thinkingTimeMs = ordered.reduce(
        (totalMs, participation) =>
          totalMs +
          Math.max(
            0,
            (participation.claim.movedAt as number) -
              participation.claim.createdAt,
          ),
        0,
      );
      const stakeMicroUsdc = ordered.reduce(
        (totalStake, participation) =>
          totalStake + participation.claim.stakeMicrousdc,
        0,
      );
      const finishedCommon = {
        yourSide: claim.side,
        stakeMicroUsdc,
        thinkingTimeMs,
        startedAt: new Date(game.createdAt).toISOString(),
        result: game.result,
        termination: game.termination,
        repetitionAdjudication: repetitionAdjudicationFor(game),
        finishedAt: new Date(game.finishedAt).toISOString(),
      };
      if (ordered.every((participation) => participation.claim.demo))
        return {
          ...finishedCommon,
          yourMoves: ordered.map((participation) => ({
            uci: participation.claim.moveUci as string,
            san: participation.claim.moveSan as string,
          })),
          demo: true,
          payoutMicroUsdc: 0,
          payoutStatus: null,
          statsCounted: false,
        };
      for (const participation of ordered) {
        if (participation.claim.movedPly === null)
          throw new Error(
            `staked game ${game.id} has a claim without moved ply`,
          );
        if (
          !participation.claim.demo &&
          entryByClaim.get(participation.claim.id) === undefined
        )
          throw new Error(
            `staked claim ${participation.claim.id} lacks entry data`,
          );
      }
      const payout = ordered.reduce(
        (totalPayout, participation) =>
          totalPayout +
          (entryByClaim.get(participation.claim.id)?.payoutAmount ?? 0),
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
        yourMoves: ordered.map((participation) => ({
          uci: participation.claim.moveUci as string,
          san: participation.claim.moveSan as string,
          ply: participation.claim.movedPly as number,
        })),
        demo: false,
        gameId: game.id,
        gameName: game.name,
        finalFen: game.fen,
        payTxid:
          ordered.length === 1
            ? (entryByClaim.get(claim.id)?.payTxid ?? null)
            : null,
        payoutMicroUsdc: payout,
        payoutTxid: job?.txid ?? null,
        payoutStatus,
        statsCounted: true,
      };
    });
    return c.json({ items, page: query.page, pageCount, total });
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
        const decisions = author.wins + author.draws + author.losses;
        return {
          ...ply,
          author: {
            nickname: author.nickname,
            kind: author.kind,
            winratePct:
              decisions === 0 ? null : (author.wins / decisions) * 100,
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
    const svg = buildCardSvg({
      gameId: game.id,
      authorNickname: author?.nickname ?? null,
      outcome,
      fen: ply.fenAfter,
      moveUci: ply.move.uci,
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
