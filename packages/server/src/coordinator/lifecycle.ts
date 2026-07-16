import {
  canTransition,
  type GameResult,
  gameRulesSchema,
  gameStallDue,
  type Move,
  nextClaimDelaySeconds,
  type Rng,
  STARTING_FEN,
  type Termination,
  type Uci,
} from "@onestepchess/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { newId } from "../ids.js";
import type { Logger } from "../logger.js";
import { generateName } from "../names.js";
import type { ChessAdapterRegistry } from "./chess-registry.js";
import type { CommandContext, Coordinator } from "./queue.js";
import { parseGameRules, type TimerKind, type TimerService } from "./timers.js";

export type LifecycleDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly views: import("./views.js").CoordinatorViews;
  readonly timers: TimerService;
  readonly registry: ChessAdapterRegistry;
  readonly config: () => ServerConfig;
  readonly rng: Rng;
  readonly logger: Logger;
};

export type ApplyPlyResult = {
  readonly move: Move;
  readonly fenAfter: string;
  readonly ply: number;
  readonly status: "active" | "endspiel" | "finished";
  readonly result: GameResult | null;
  readonly termination: Termination | null;
};

export type LifecycleApi = {
  applyCommittedPly(
    ctx: CommandContext,
    args: { readonly gameId: string; readonly move: Move },
  ): ApplyPlyResult;
};

const HOUR_MS = 3_600_000;

export function registerLifecycle(deps: LifecycleDeps): LifecycleApi {
  const { coordinator, db, views, timers, registry } = deps;

  const stallDueAt = (lastPlyAt: number, stallAbortHours: number): number =>
    lastPlyAt + stallAbortHours * HOUR_MS;

  const nameTaken = (name: string): boolean =>
    db
      .select({ id: schema.games.id })
      .from(schema.games)
      .where(eq(schema.games.name, name))
      .get() !== undefined;

  const uniqueName = (): string => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const name = generateName(deps.rng);
      if (!nameTaken(name)) {
        return name;
      }
    }
    throw new Error("word list exhausted generating a unique game name");
  };

  const liveGameCount = (): number => {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.games)
      .where(inArray(schema.games.status, ["active", "endspiel"]))
      .get();
    return row?.n ?? 0;
  };

  coordinator.register("PoolTick", (ctx) => {
    const config = deps.config();
    const target = config.GAME_POOL_TARGET;
    const rules = gameRulesSchema.parse(config);
    const rulesJson = JSON.stringify(rules);
    const created: { id: string; name: string }[] = [];
    for (let live = liveGameCount(); live < target; live += 1) {
      const id = newId("gm_");
      const name = uniqueName();
      db.insert(schema.games)
        .values({
          id,
          name,
          status: "active",
          fen: STARTING_FEN,
          ply: 0,
          historyJson: "[]",
          rulesJson,
          minNextClaimAt: 0,
          lastPlyAt: ctx.now,
          createdAt: ctx.now,
        })
        .run();
      created.push({ id, name });
    }
    ctx.afterCommit(() => {
      for (const game of created) {
        views.games.set(game.id, {
          id: game.id,
          name: game.name,
          status: "active",
          fen: STARTING_FEN,
          ply: 0,
          minNextClaimAt: 0,
          lastPlyAt: ctx.now,
          rules,
        });
        timers.arm(
          "gameStall",
          game.id,
          stallDueAt(ctx.now, rules.STALL_ABORT_HOURS),
        );
      }
    });
    return { created: created.length };
  });

  // Resolution (F7) lands with the S6 slice; the post-commit enqueue point
  // is pinned here so terminal transitions already flow through it.
  coordinator.register("GameFinished", () => null);

  const applyCommittedPly = (
    ctx: CommandContext,
    args: { readonly gameId: string; readonly move: Move },
  ): ApplyPlyResult => {
    const game = db
      .select()
      .from(schema.games)
      .where(eq(schema.games.id, args.gameId))
      .get();
    if (game === undefined) {
      throw new Error(`unknown game: ${args.gameId}`);
    }
    if (game.status === "finished" || game.status === "aborted") {
      throw new Error(`ply on terminal game: ${args.gameId}`);
    }
    const rules = parseGameRules(game.rulesJson);
    const adapter = registry.get(rules);
    const history = JSON.parse(game.historyJson) as Uci[];
    const state = adapter.fromHistory(history);
    const next = adapter.apply(state, args.move);
    const ply = next.history.length;

    let status: "active" | "endspiel" | "finished" = game.status;
    let endspielPly = game.endspielPly;
    if (status === "active" && adapter.phase(next) === "endspiel") {
      // One-way ratchet: only active → endspiel ever assigns these.
      status = "endspiel";
      endspielPly = ply;
    }
    const phase = status === "endspiel" ? "endspiel" : "normal";

    let result: GameResult | null = null;
    let termination: Termination | null = null;
    let finishedAt: number | null = null;
    const terminal = adapter.terminal(next);
    if (terminal.over) {
      status = "finished";
      result = terminal.result;
      termination = terminal.termination;
      finishedAt = ctx.now;
    }
    if (status !== game.status && !canTransition("game", game.status, status)) {
      throw new Error(`illegal game transition ${game.status} → ${status}`);
    }

    const minNextClaimAt = terminal.over
      ? game.minNextClaimAt
      : ctx.now + nextClaimDelaySeconds(phase, rules) * 1_000;

    db.update(schema.games)
      .set({
        fen: next.fen,
        historyJson: JSON.stringify(next.history),
        ply,
        lastPlyAt: ctx.now,
        status,
        endspielPly,
        result,
        termination,
        finishedAt,
        minNextClaimAt,
      })
      .where(eq(schema.games.id, args.gameId))
      .run();

    ctx.afterCommit(() => {
      if (terminal.over) {
        views.games.delete(args.gameId);
        timers.disarm("gameStall", args.gameId);
        timers.disarm("minNextClaim", args.gameId);
        void coordinator.dispatch({
          type: "GameFinished",
          payload: { gameId: args.gameId },
          refIds: [args.gameId],
        });
        void coordinator.dispatch({ type: "PoolTick", payload: {} });
        return;
      }
      const view = views.games.get(args.gameId);
      if (view !== undefined) {
        view.fen = next.fen;
        view.ply = ply;
        view.lastPlyAt = ctx.now;
        view.minNextClaimAt = minNextClaimAt;
        if (status === "endspiel" && view.status === "active") {
          views.games.set(args.gameId, { ...view, status: "endspiel" });
        }
      }
      timers.arm(
        "gameStall",
        args.gameId,
        stallDueAt(ctx.now, rules.STALL_ABORT_HOURS),
      );
      if (minNextClaimAt > ctx.now) {
        timers.arm("minNextClaim", args.gameId, minNextClaimAt);
      }
    });

    return {
      move: args.move,
      fenAfter: next.fen,
      ply,
      status,
      result,
      termination,
    };
  };

  const onGameStall = (ctx: CommandContext, gameId: string): void => {
    const game = db
      .select()
      .from(schema.games)
      .where(eq(schema.games.id, gameId))
      .get();
    if (
      game === undefined ||
      game.status === "finished" ||
      game.status === "aborted"
    ) {
      return;
    }
    const rules = parseGameRules(game.rulesJson);
    if (
      !gameStallDue(
        { status: game.status, lastPlyAt: game.lastPlyAt },
        ctx.now,
        rules,
      )
    ) {
      // Idempotent re-check: the deadline moved since this timer was armed.
      ctx.afterCommit(() => {
        timers.arm(
          "gameStall",
          gameId,
          stallDueAt(game.lastPlyAt, rules.STALL_ABORT_HOURS),
        );
      });
      return;
    }

    // The open claim expires first (F6); nothing was charged.
    const openClaim = db
      .select()
      .from(schema.claims)
      .where(
        and(eq(schema.claims.gameId, gameId), eq(schema.claims.status, "open")),
      )
      .get();
    if (openClaim !== undefined) {
      db.update(schema.claims)
        .set({ status: "expired" })
        .where(eq(schema.claims.id, openClaim.id))
        .run();
      ctx.appendEvent("claim_expired", openClaim.player, {
        claimId: openClaim.id,
      });
    }

    db.update(schema.games)
      .set({
        status: "aborted",
        result: "aborted",
        termination: "aborted",
        finishedAt: ctx.now,
      })
      .where(eq(schema.games.id, gameId))
      .run();

    ctx.afterCommit(() => {
      if (openClaim !== undefined) {
        views.removeOpenClaim(openClaim.id);
        timers.disarm("claimDeadline", openClaim.id);
      }
      views.games.delete(gameId);
      timers.disarm("gameStall", gameId);
      timers.disarm("minNextClaim", gameId);
      deps.logger.warn({ gameId }, "stall abort");
      void coordinator.dispatch({
        type: "GameFinished",
        payload: { gameId },
        refIds: [gameId],
      });
      void coordinator.dispatch({ type: "PoolTick", payload: {} });
    });
  };

  const timerHandlers: Partial<
    Record<TimerKind, (ctx: CommandContext, refId: string) => void>
  > = {
    gameStall: onGameStall,
  };

  coordinator.register(
    "TimerFired",
    (ctx, payload: { kind: TimerKind; refId: string }) => {
      timerHandlers[payload.kind]?.(ctx, payload.refId);
      return null;
    },
  );

  return { applyCommittedPly };
}
