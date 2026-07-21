import type { PaymentRail, Rng } from "@onestepchess/core";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { z } from "zod";
import { CardCache } from "../../cards/raster.js";
import { buildCardSvg, type CardOutcome } from "../../cards/svg.js";
import type { ServerConfig } from "../../config.js";
import type { Coordinator } from "../../coordinator/queue.js";
import type { Db } from "../../db/open.js";
import { schema } from "../../db/open.js";
import { generateName } from "../../names.js";
import { type AppEnv, AppError } from "../app.js";
import {
  cardQuerySchema,
  gamesQuerySchema,
  renameBodySchema,
} from "../contracts.js";
import { type AuthRouteDeps, sessionAuth } from "./auth.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NICKNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;

export type HumanRouteDeps = {
  readonly db: Db;
  readonly coordinator: Coordinator;
  readonly rail: PaymentRail;
  readonly config: () => ServerConfig;
  readonly jwtSecret: string;
  readonly publicBaseUrl: string;
  readonly trustProxyHops: number;
  readonly now: () => number;
  readonly rng: Rng;
};

function nicknameTaken(db: Db, nickname: string, except: string): boolean {
  return (
    db
      .select({ address: schema.players.address })
      .from(schema.players)
      .where(
        and(
          sql`${schema.players.nickname} = ${nickname} COLLATE NOCASE`,
          ne(schema.players.address, except),
        ),
      )
      .get() !== undefined
  );
}

function freeNickname(db: Db, rng: Rng): string {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const nickname = generateName(rng);
    const taken = db
      .select({ address: schema.players.address })
      .from(schema.players)
      .where(sql`${schema.players.nickname} = ${nickname} COLLATE NOCASE`)
      .get();
    if (taken === undefined) return nickname;
  }
  throw new Error("word list exhausted generating a nickname");
}

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

function playerView(player: typeof schema.players.$inferSelect) {
  return {
    address: player.address,
    kind: player.kind,
    nickname: player.nickname,
    createdAt: new Date(player.createdAt).toISOString(),
  };
}

function parseQuery<T>(schema_: z.ZodType<T>, value: unknown): T {
  const parsed = schema_.safeParse(value);
  if (!parsed.success)
    throw new AppError("INVALID_REQUEST", { hint: "invalid query parameters" });
  return parsed.data;
}

export function registerHumanRoutes(
  app: Hono<AppEnv>,
  deps: HumanRouteDeps,
): void {
  const auth = sessionAuth(deps as unknown as AuthRouteDeps);
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
    const raw = await c.req.json().catch(() => null);
    const parsed = renameBodySchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError("INVALID_REQUEST", { hint: "nickname is required" });
    if (!NICKNAME_PATTERN.test(parsed.data.nickname))
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
        nickname: parsed.data.nickname,
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
    const pageSize =
      query.status === "ongoing"
        ? deps.config().PAGE_SIZE_ACTIVE
        : deps.config().PAGE_SIZE_FINISHED;
    const total = participations.length;
    const pageCount = Math.ceil(total / pageSize);
    const selected = participations.slice(
      (query.page - 1) * pageSize,
      query.page * pageSize,
    );
    const items = selected.map(({ claim, game }) => {
      if (
        claim.moveUci === null ||
        claim.moveSan === null ||
        claim.movedAt === null
      )
        throw new Error(`moved claim ${claim.id} lacks move data`);
      const entry = entryByClaim.get(claim.id);
      const common = {
        yourMove: { uci: claim.moveUci, san: claim.moveSan },
        yourSide: claim.side,
        demo: claim.demo,
        stakeMicroUsdc: claim.stakeMicrousdc,
        claimedAt: new Date(claim.createdAt).toISOString(),
        movedAt: new Date(claim.movedAt).toISOString(),
      };
      if (query.status === "ongoing")
        return { ...common, payTxid: entry?.payTxid ?? null };
      if (
        game.result === null ||
        game.termination === null ||
        game.finishedAt === null
      )
        throw new Error(`terminal game ${game.id} lacks result data`);
      if (claim.demo)
        return {
          ...common,
          result: game.result,
          termination: game.termination,
          payoutMicroUsdc: 0,
          payoutStatus: null,
          statsCounted: false,
          finishedAt: new Date(game.finishedAt).toISOString(),
        };
      if (entry === undefined || claim.movedPly === null)
        throw new Error(`staked claim ${claim.id} lacks entry data`);
      const payout = entry.payoutAmount ?? 0;
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
        ...common,
        gameId: game.id,
        gameName: game.name,
        finalFen: game.fen,
        result: game.result,
        termination: game.termination,
        yourPly: claim.movedPly,
        payTxid: entry.payTxid,
        payoutMicroUsdc: payout,
        payoutTxid: job?.txid ?? null,
        payoutStatus,
        statsCounted: true,
        finishedAt: new Date(game.finishedAt).toISOString(),
      };
    });
    return c.json({ items, page: query.page, pageCount, total });
  });

  app.get("/api/v1/games/:id/replay", (c) => {
    const game = deps.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.id, c.req.param("id")))
      .get();
    if (
      game === undefined ||
      (game.status !== "finished" && game.status !== "aborted") ||
      game.replayJson === null ||
      game.result === null ||
      game.termination === null ||
      game.finishedAt === null
    )
      throw new AppError("GAME_NOT_FOUND", { hint: "game not found" });
    const stored = JSON.parse(game.replayJson) as {
      plies: Array<{
        ply: number;
        side: "white" | "black";
        move: { uci: string; san: string };
        fenAfter: string;
        authorAddress: string;
        stakeMicroUsdc: number;
        demo: boolean;
      }>;
      pgn: string;
    };
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
    return c.json({
      gameId: game.id,
      name: game.name,
      result: game.result,
      termination: game.termination,
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
          },
        };
      }),
      pgn: stored.pgn,
    });
  });

  app.get("/api/v1/games/:id/card.png", async (c) => {
    const game = deps.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.id, c.req.param("id")))
      .get();
    // I7 parity with the replay route: unknown and non-terminal ids are the
    // same GAME_NOT_FOUND, so a card never leaks a game's existence (F16).
    if (
      game === undefined ||
      (game.status !== "finished" && game.status !== "aborted") ||
      game.replayJson === null ||
      game.result === null
    )
      throw new AppError("GAME_NOT_FOUND", { hint: "game not found" });
    const stored = JSON.parse(game.replayJson) as {
      plies: Array<{
        ply: number;
        side: "white" | "black";
        move: { uci: string; san: string };
        fenAfter: string;
        authorAddress: string;
        demo: boolean;
      }>;
    };
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
      gameName: game.name,
      authorNickname: author?.nickname ?? null,
      outcome,
      fen: ply.fenAfter,
      moveUci: ply.move.uci,
      side: ply.side,
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
