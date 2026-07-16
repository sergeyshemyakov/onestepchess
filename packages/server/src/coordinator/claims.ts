import {
  claimExpiryDue,
  claimTerms,
  type Move,
  normalizeMove,
  type PaymentRail,
  rollingWindowCheck,
  selectGame,
} from "@onestepchess/core";
import { and, eq, inArray } from "drizzle-orm";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { newId } from "../ids.js";
import type { ChessAdapterRegistry } from "./chess-registry.js";
import type { LifecycleApi } from "./lifecycle.js";
import type { Coordinator } from "./queue.js";
import type { TimerService } from "./timers.js";
import type { CoordinatorViews } from "./views.js";

export type ClaimDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly views: CoordinatorViews;
  readonly timers: TimerService;
  readonly registry: ChessAdapterRegistry;
  readonly lifecycle: LifecycleApi;
  readonly config: () => ServerConfig;
  readonly rail: PaymentRail;
  readonly now: () => number;
  readonly rng: () => number;
};

export type ClaimRecord = typeof schema.claims.$inferSelect;

export type MoveReceipt = {
  readonly status: "moved";
  readonly move: Move;
  readonly debitMicroUsdc: number;
  readonly txid: string | null;
  readonly explorerUrl: string | null;
  readonly fenAfterYourMove: string;
};

export function receiptFor(claim: ClaimRecord): MoveReceipt {
  if (
    claim.moveUci === null ||
    claim.moveSan === null ||
    claim.fenAfter === null
  ) {
    throw new Error(`moved claim ${claim.id} lacks a durable receipt`);
  }
  const txid = claim.demo
    ? null
    : claim.moveUci.startsWith("tx:")
      ? claim.moveUci.slice(3)
      : null;
  return {
    status: "moved",
    move: {
      uci: claim.demo ? claim.moveUci : claim.moveUci.replace(/^tx:[^:]+:/, ""),
      san: claim.moveSan,
    },
    debitMicroUsdc: claim.demo ? 0 : claim.stakeMicrousdc,
    txid,
    explorerUrl: txid === null ? null : null,
    fenAfterYourMove: claim.fenAfter,
  };
}

function moveClaim(
  deps: ClaimDeps,
  ctx: import("./queue.js").CommandContext,
  args: {
    claim: ClaimRecord;
    move: Move;
    txid: string | null;
    response: string | null;
  },
): MoveReceipt {
  const applied = deps.lifecycle.applyCommittedPly(ctx, {
    gameId: args.claim.gameId,
    move: args.move,
  });
  deps.db
    .update(schema.claims)
    .set({
      status: "moved",
      movedAt: ctx.now,
      movedPly: applied.ply,
      // The settlement txid is kept on the intent; the claim retains pure UCI.
      moveUci: args.move.uci,
      moveSan: args.move.san,
      fenAfter: applied.fenAfter,
      nudgeDueAt: ctx.now + deps.config().NEXT_GAME_NUDGE_SECONDS * 1_000,
    })
    .where(eq(schema.claims.id, args.claim.id))
    .run();
  if (args.txid !== null) {
    deps.db
      .insert(schema.stakeEntries)
      .values({
        id: newId("se_"),
        gameId: args.claim.gameId,
        claimId: args.claim.id,
        player: args.claim.player,
        side: args.claim.side,
        kind: "human",
        amount: args.claim.stakeMicrousdc,
        payTxid: args.txid,
        ply: applied.ply,
        createdAt: ctx.now,
      })
      .run();
    deps.db
      .insert(schema.ledger)
      .values({
        ts: ctx.now,
        account: "treasury",
        deltaMicrousdc: args.claim.stakeMicrousdc,
        refType: "stake",
        refId: args.claim.id,
        txid: args.txid,
      })
      .run();
  }
  ctx.appendEvent("claim_moved", args.claim.player, { claimId: args.claim.id });
  ctx.afterCommit(() => {
    deps.views.removeOpenClaim(args.claim.id);
    deps.timers.disarm("claimDeadline", args.claim.id);
  });
  return {
    status: "moved",
    move: args.move,
    debitMicroUsdc: args.txid === null ? 0 : args.claim.stakeMicrousdc,
    txid: args.txid,
    explorerUrl: args.txid === null ? null : null,
    fenAfterYourMove: applied.fenAfter,
  };
}

export function registerClaimCommands(deps: ClaimDeps): void {
  deps.coordinator.register(
    "PaymentIntentOpened",
    (
      ctx,
      payload: {
        claimId: string;
        player: string;
        move: Move;
        clientTxid: string;
        amount: number;
        lastValidRound: number | null;
      },
    ) => {
      const existing = deps.db
        .select()
        .from(schema.paymentIntents)
        .where(eq(schema.paymentIntents.clientTxid, payload.clientTxid))
        .get();
      if (existing !== undefined) return existing.status;
      const claim = deps.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, payload.claimId))
        .get();
      if (
        claim === undefined ||
        claim.player !== payload.player ||
        claim.status !== "open" ||
        claim.stakeMicrousdc !== payload.amount
      )
        throw new Error("payment intent no longer binds an open claim");
      const inFlight = deps.db
        .select({ id: schema.paymentIntents.id })
        .from(schema.paymentIntents)
        .where(
          and(
            eq(schema.paymentIntents.claimId, claim.id),
            inArray(schema.paymentIntents.status, ["verified", "settling"]),
          ),
        )
        .get();
      if (inFlight !== undefined) return "in_flight";
      deps.db
        .insert(schema.paymentIntents)
        .values({
          id: newId("pi_"),
          claimId: claim.id,
          player: claim.player,
          moveUci: payload.move.uci,
          amount: payload.amount,
          clientTxid: payload.clientTxid,
          status: "verified",
          lastValidRound: payload.lastValidRound,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run();
      return "verified";
    },
  );
  deps.coordinator.register(
    "IntentMarkedSettling",
    (ctx, payload: { clientTxid: string }) => {
      deps.db
        .update(schema.paymentIntents)
        .set({ status: "settling", updatedAt: ctx.now })
        .where(
          and(
            eq(schema.paymentIntents.clientTxid, payload.clientTxid),
            eq(schema.paymentIntents.status, "verified"),
          ),
        )
        .run();
    },
  );
  deps.coordinator.register(
    "IntentFailed",
    (ctx, payload: { clientTxid: string; failureCode: string }) => {
      deps.db
        .update(schema.paymentIntents)
        .set({
          status: "failed",
          failureCode: payload.failureCode,
          updatedAt: ctx.now,
        })
        .where(
          and(
            eq(schema.paymentIntents.clientTxid, payload.clientTxid),
            inArray(schema.paymentIntents.status, ["verified", "settling"]),
          ),
        )
        .run();
    },
  );
  deps.coordinator.register(
    "ClaimRequested",
    (
      ctx,
      payload: {
        player: string;
        kind: "human" | "agent" | "guest";
        demo: boolean;
      },
    ) => {
      const existingId = deps.views.openClaimByPlayer.get(payload.player);
      if (existingId !== undefined)
        return {
          claim: deps.db
            .select()
            .from(schema.claims)
            .where(eq(schema.claims.id, existingId))
            .get(),
          created: false,
        };
      const player = deps.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, payload.player))
        .get();
      if (player === undefined || player.banned)
        throw new Error("player unavailable");
      const config = deps.config();
      const timestamps =
        deps.views.quota.get(payload.player)?.[
          payload.demo ? "demo" : "staked"
        ] ?? [];
      const limit = payload.demo
        ? config.QUOTA_DEMO
        : (player.quotaOverride ??
          (payload.kind === "agent" ? config.QUOTA_AGENT : config.QUOTA_HUMAN));
      const quota = rollingWindowCheck({
        eventTimestamps: timestamps,
        limit,
        windowSeconds: 3600,
        now: ctx.now,
      });
      if (!quota.ok)
        return {
          claim: null,
          created: false,
          retryAfterSeconds: quota.retryAfterSeconds,
          quota: true,
        };
      const games = [...deps.views.games.values()].map((game) => ({
        ...game,
        hasOpenClaim: deps.views.openClaimByGame.has(game.id),
        cooldownPlies: game.rules.COOLDOWN_PLIES,
      }));
      const stakedParticipation = deps.db
        .select({
          gameId: schema.stakeEntries.gameId,
          side: schema.stakeEntries.side,
          lastPly: schema.stakeEntries.ply,
        })
        .from(schema.stakeEntries)
        .where(eq(schema.stakeEntries.player, payload.player))
        .all();
      const demoParticipation = deps.db
        .select({
          gameId: schema.claims.gameId,
          side: schema.claims.side,
          lastPly: schema.claims.movedPly,
        })
        .from(schema.claims)
        .where(
          and(
            eq(schema.claims.player, payload.player),
            eq(schema.claims.status, "moved"),
            eq(schema.claims.demo, true),
          ),
        )
        .all()
        .flatMap((row) =>
          row.lastPly === null
            ? []
            : [{ gameId: row.gameId, side: row.side, lastPly: row.lastPly }],
        );
      const participation = [...stakedParticipation, ...demoParticipation];
      const game = selectGame({
        games,
        requesterKind: payload.kind,
        participation,
        now: ctx.now,
        rng: deps.rng,
      });
      if (game === null)
        return { claim: null, created: false, retryAfterSeconds: 1 };
      const selectedView = deps.views.games.get(game.id);
      if (selectedView === undefined)
        return { claim: null, created: false, retryAfterSeconds: 1 };
      const terms = claimTerms({
        game,
        requesterKind: payload.kind,
        demo: payload.demo,
        now: ctx.now,
        cfg: selectedView.rules,
      });
      const claim = {
        id: newId("clm_"),
        gameId: game.id,
        player: payload.player,
        side: terms.side,
        demo: payload.demo,
        stakeMicrousdc: terms.stakeMicroUsdc,
        status: "open" as const,
        createdAt: ctx.now,
        deadline: terms.deadline,
      };
      deps.db.insert(schema.claims).values(claim).run();
      ctx.appendEvent("claim_created", payload.player, { claimId: claim.id });
      ctx.afterCommit(() => {
        deps.views.setOpenClaim(claim);
        deps.views.countClaim(claim.player, claim.demo, claim.createdAt);
        deps.timers.arm("claimDeadline", claim.id, claim.deadline);
      });
      return { claim, created: true };
    },
  );

  deps.coordinator.register(
    "DemoMoveSubmitted",
    (ctx, payload: { claimId: string; player: string; move: Move }) => {
      const claim = deps.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, payload.claimId))
        .get();
      if (
        claim === undefined ||
        claim.player !== payload.player ||
        claim.status !== "open" ||
        !claim.demo
      )
        throw new Error("invalid demo claim");
      return moveClaim(deps, ctx, {
        claim,
        move: payload.move,
        txid: null,
        response: null,
      });
    },
  );
  deps.coordinator.register(
    "MoveSettled",
    (
      ctx,
      payload: {
        claimId: string;
        player: string;
        move: Move;
        clientTxid: string;
        txid: string;
        response: string;
      },
    ) => {
      const claim = deps.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, payload.claimId))
        .get();
      if (
        claim === undefined ||
        claim.player !== payload.player ||
        claim.status !== "open"
      )
        throw new Error("invalid settled claim");
      deps.db
        .update(schema.paymentIntents)
        .set({
          status: "settled",
          settleTxid: payload.txid,
          paymentResponseHeader: payload.response,
          updatedAt: ctx.now,
        })
        .where(eq(schema.paymentIntents.clientTxid, payload.clientTxid))
        .run();
      return moveClaim(deps, ctx, {
        claim,
        move: payload.move,
        txid: payload.txid,
        response: payload.response,
      });
    },
  );
  deps.coordinator.register(
    "ExpireClaim",
    (ctx, payload: { claimId: string }) => {
      const claim = deps.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, payload.claimId))
        .get();
      if (claim === undefined) return false;
      const intent = deps.db
        .select()
        .from(schema.paymentIntents)
        .where(
          and(
            eq(schema.paymentIntents.claimId, claim.id),
            inArray(schema.paymentIntents.status, ["verified", "settling"]),
          ),
        )
        .get();
      if (!claimExpiryDue(claim, intent !== undefined, ctx.now)) return false;
      deps.db
        .update(schema.claims)
        .set({ status: "expired" })
        .where(eq(schema.claims.id, claim.id))
        .run();
      deps.db
        .update(schema.players)
        .set({
          abandonCount:
            (deps.db
              .select()
              .from(schema.players)
              .where(eq(schema.players.address, claim.player))
              .get()?.abandonCount ?? 0) + 1,
        })
        .where(eq(schema.players.address, claim.player))
        .run();
      const updated = deps.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, claim.player))
        .get();
      if (
        updated !== undefined &&
        updated.abandonCount >= deps.config().ABANDON_THRESHOLD
      ) {
        deps.db
          .update(schema.players)
          .set({
            deprioritizedUntil:
              ctx.now + deps.config().DEPRIORITIZE_HOURS * 3_600_000,
          })
          .where(eq(schema.players.address, claim.player))
          .run();
      }
      ctx.appendEvent("claim_expired", claim.player, { claimId: claim.id });
      ctx.afterCommit(() => {
        deps.views.removeOpenClaim(claim.id);
        deps.timers.disarm("claimDeadline", claim.id);
      });
      return true;
    },
  );
}

export function legalMove(deps: ClaimDeps, claim: ClaimRecord, input: string) {
  const game = deps.db
    .select()
    .from(schema.games)
    .where(eq(schema.games.id, claim.gameId))
    .get();
  if (game === undefined) throw new Error("claim game missing");
  return normalizeMove(
    deps.registry
      .get(JSON.parse(game.rulesJson))
      .fromHistory(JSON.parse(game.historyJson)),
    input,
  );
}
