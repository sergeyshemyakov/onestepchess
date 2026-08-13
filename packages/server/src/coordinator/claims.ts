import {
  claimExpiryDue,
  claimTerms,
  type Move,
  normalizeMove,
  type PaymentRail,
  rollingWindowCheck,
  selectGame,
} from "@onestepchess/core";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { ServerConfig } from "../config.js";
import { appendLedgerEntry } from "../db/ledger.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { newId } from "../ids.js";
import { maybeAwardReferral } from "../incentives/points.js";
import { bumpRefJoined } from "../incentives/referrals.js";
import { agentMayClaim, humanBoardCapacity } from "./capacity.js";
import type { ChessAdapterRegistry } from "./chess-registry.js";
import type { LifecycleApi } from "./lifecycle.js";
import type { Coordinator } from "./queue.js";
import type { TimerService } from "./timers.js";
import { parseGameRules } from "./timers.js";
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
  readonly publicStats?: { recordStakedMoveSettled(isHuman: boolean): void };
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

type Participation = {
  readonly gameId: string;
  readonly side: "white" | "black";
  readonly lastPly: number;
};

function loadParticipation(db: Db, player: string): Participation[] {
  const staked = db
    .select({
      gameId: schema.stakeEntries.gameId,
      side: schema.stakeEntries.side,
      lastPly: max(schema.stakeEntries.ply),
    })
    .from(schema.stakeEntries)
    .where(eq(schema.stakeEntries.player, player))
    .groupBy(schema.stakeEntries.gameId, schema.stakeEntries.side)
    .all();
  const demo = db
    .select({
      gameId: schema.claims.gameId,
      side: schema.claims.side,
      lastPly: max(schema.claims.movedPly),
    })
    .from(schema.claims)
    .where(
      and(
        eq(schema.claims.player, player),
        eq(schema.claims.status, "moved"),
        eq(schema.claims.demo, true),
      ),
    )
    .groupBy(schema.claims.gameId, schema.claims.side)
    .all();

  const latestByGame = new Map<string, Participation>();
  for (const row of [...staked, ...demo]) {
    if (row.lastPly === null) continue;
    const prior = latestByGame.get(row.gameId);
    if (prior === undefined || row.lastPly > prior.lastPly) {
      latestByGame.set(row.gameId, {
        gameId: row.gameId,
        side: row.side,
        lastPly: row.lastPly,
      });
    }
  }
  return [...latestByGame.values()];
}

function loadParticipantSides(
  db: Db,
  player: string,
): Map<string, "white" | "black"> {
  const sides = new Map<string, "white" | "black">();
  for (const row of db
    .select({
      gameId: schema.stakeEntries.gameId,
      side: schema.stakeEntries.side,
    })
    .from(schema.stakeEntries)
    .where(eq(schema.stakeEntries.player, player))
    .all()) {
    sides.set(row.gameId, row.side);
  }
  for (const row of db
    .select({ gameId: schema.claims.gameId, side: schema.claims.side })
    .from(schema.claims)
    .where(
      and(eq(schema.claims.player, player), eq(schema.claims.status, "moved")),
    )
    .all()) {
    sides.set(row.gameId, row.side);
  }
  return sides;
}

export function receiptFor(
  claim: ClaimRecord,
  txid: string | null,
  explorerBaseUrl: string,
): MoveReceipt {
  if (
    claim.moveUci === null ||
    claim.moveSan === null ||
    claim.fenAfter === null
  ) {
    throw new Error(`moved claim ${claim.id} lacks a durable receipt`);
  }
  if (!claim.demo && txid === null) {
    throw new Error(`paid claim ${claim.id} lacks a settlement txid`);
  }
  return {
    status: "moved",
    move: {
      uci: claim.moveUci,
      san: claim.moveSan,
    },
    debitMicroUsdc: claim.demo ? 0 : claim.stakeMicrousdc,
    txid: claim.demo ? null : txid,
    explorerUrl:
      claim.demo || txid === null ? null : `${explorerBaseUrl}/tx/${txid}`,
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
    const player = deps.db
      .select({ kind: schema.players.kind })
      .from(schema.players)
      .where(eq(schema.players.address, args.claim.player))
      .get();
    if (player === undefined || player.kind === "guest") {
      throw new Error(`paid claim ${args.claim.id} has no staking player`);
    }
    deps.db
      .insert(schema.stakeEntries)
      .values({
        id: newId("se_"),
        gameId: args.claim.gameId,
        claimId: args.claim.id,
        player: args.claim.player,
        side: args.claim.side,
        kind: player.kind,
        amount: args.claim.stakeMicrousdc,
        payTxid: args.txid,
        ply: applied.ply,
        createdAt: ctx.now,
      })
      .run();
    appendLedgerEntry(deps.db, {
      ts: ctx.now,
      account: "treasury",
      deltaMicrousdc: args.claim.stakeMicrousdc,
      refType: "stake",
      refId: args.claim.id,
      txid: args.txid,
    });
  }
  ctx.appendEvent("move_accepted", args.claim.player, {
    claimId: args.claim.id,
    txid: args.txid,
  });
  ctx.afterCommit(() => {
    deps.views.removeOpenClaim(args.claim.id);
    deps.timers.disarm("claimReveal", args.claim.id);
    deps.timers.disarm("claimDeadline", args.claim.id);
    deps.timers.arm(
      "nudge",
      args.claim.id,
      ctx.now + deps.config().NEXT_GAME_NUDGE_SECONDS * 1_000,
    );
  });
  return receiptFor(
    {
      ...args.claim,
      status: "moved",
      moveUci: args.move.uci,
      moveSan: args.move.san,
      fenAfter: applied.fenAfter,
    },
    args.txid,
    deps.config().EXPLORER_BASE_URL,
  );
}

/** How soon a blocked expiry re-checks whether its in-flight intent resolved. */
const CLAIM_EXPIRY_RETRY_MS = 5_000;

function expireClaimIfDue(
  deps: ClaimDeps,
  ctx: import("./queue.js").CommandContext,
  claimId: string,
): boolean {
  const claim = deps.db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.id, claimId))
    .get();
  if (claim === undefined) return false;
  const intent = deps.db
    .select({ id: schema.paymentIntents.id })
    .from(schema.paymentIntents)
    .where(
      and(
        eq(schema.paymentIntents.claimId, claim.id),
        inArray(schema.paymentIntents.status, ["verified", "settling"]),
      ),
    )
    .get();
  if (!claimExpiryDue(claim, intent !== undefined, ctx.now)) {
    // A claim past its deadline with an in-flight intent must wait for
    // payment recovery, but the deadline timer has already fired — without a
    // retry the claim would stay open forever once the intent resolves.
    if (
      claim.status === "open" &&
      ctx.now >= claim.deadline &&
      intent !== undefined
    ) {
      const retryAt = ctx.now + CLAIM_EXPIRY_RETRY_MS;
      ctx.afterCommit(() => {
        deps.timers.arm("claimDeadline", claim.id, retryAt);
      });
    }
    return false;
  }
  deps.db
    .update(schema.claims)
    .set({ status: "expired" })
    .where(eq(schema.claims.id, claim.id))
    .run();
  const updated = deps.db
    .update(schema.players)
    .set({
      abandonCount: sql`${schema.players.abandonCount} + 1`,
    })
    .where(eq(schema.players.address, claim.player))
    .returning({ abandonCount: schema.players.abandonCount })
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
    deps.timers.disarm("claimReveal", claim.id);
    deps.timers.disarm("claimDeadline", claim.id);
  });
  return true;
}

export function registerClaimCommands(deps: ClaimDeps): void {
  deps.coordinator.register(
    "ClaimExpiring",
    (ctx, payload: { claimId: string }) => {
      const claim = deps.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, payload.claimId))
        .get();
      if (claim === undefined || claim.status !== "open") return false;
      const dueAt = Math.max(
        claim.createdAt,
        claim.deadline - deps.config().TIMER_REVEAL_SECONDS * 1_000,
      );
      if (dueAt > ctx.now) {
        ctx.afterCommit(() => {
          deps.timers.arm("claimReveal", claim.id, dueAt);
        });
        return false;
      }
      const payloadJson = JSON.stringify({
        claimId: claim.id,
        deadline: new Date(claim.deadline).toISOString(),
      });
      const existing = deps.db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.player, claim.player),
            eq(schema.events.type, "claim_expiring"),
            eq(schema.events.payloadJson, payloadJson),
          ),
        )
        .get();
      if (existing !== undefined) return false;
      ctx.appendEvent("claim_expiring", claim.player, {
        claimId: claim.id,
        deadline: new Date(claim.deadline).toISOString(),
      });
      return true;
    },
  );

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
      if (existing !== undefined) {
        if (
          existing.claimId !== payload.claimId ||
          existing.player !== payload.player ||
          existing.amount !== payload.amount ||
          existing.moveUci !== payload.move.uci
        )
          return { status: "foreign" as const, created: false };
        return { status: existing.status, created: false };
      }
      const claim = deps.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, payload.claimId))
        .get();
      if (claim === undefined || claim.player !== payload.player)
        return { status: "foreign" as const, created: false };
      if (claim.status !== "open" || claim.deadline <= ctx.now)
        return { status: "expired" as const, created: false };
      if (claim.stakeMicrousdc !== payload.amount)
        return { status: "foreign" as const, created: false };
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
      if (inFlight !== undefined)
        return { status: "in_flight" as const, created: false };
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
      return { status: "verified" as const, created: true };
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
      const intent = deps.db
        .select({ claimId: schema.paymentIntents.claimId })
        .from(schema.paymentIntents)
        .where(eq(schema.paymentIntents.clientTxid, payload.clientTxid))
        .get();
      if (intent !== undefined) expireClaimIfDue(deps, ctx, intent.claimId);
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
        createGuest?: {
          turnstileVerifiedAt: number;
          referredBy: string | null;
        };
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
      if (player === undefined && payload.createGuest === undefined)
        throw new Error("player unavailable");
      if (player?.banned) throw new Error("player unavailable");
      const config = deps.config();
      if (payload.kind === "guest") {
        const consumed =
          deps.db
            .select({ count: sql<number>`count(*)` })
            .from(schema.claims)
            .where(eq(schema.claims.player, payload.player))
            .get()?.count ?? 0;
        if (consumed >= config.GUEST_CLAIM_ALLOWANCE)
          return { claim: null, created: false, guestUsed: true };
      }
      const timestamps =
        deps.views.quota.get(payload.player)?.[
          payload.demo ? "demo" : "staked"
        ] ?? [];
      // Staked human claims are uncapped (playtest feedback) — a per-player
      // quotaOverride remains the admin tool to restrict a specific player.
      const limit = payload.demo
        ? config.QUOTA_DEMO
        : (player?.quotaOverride ??
          (payload.kind === "agent" ? config.QUOTA_AGENT : null));
      if (limit !== null) {
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
      }
      const games = [...deps.views.games.values()].map((game) => ({
        ...game,
        hasOpenClaim: deps.views.openClaimByGame.has(game.id),
        cooldownPlies: game.rules.COOLDOWN_PLIES,
      }));
      const game = selectGame({
        games,
        requesterKind: payload.kind,
        participation: loadParticipation(deps.db, payload.player),
        now: ctx.now,
        rng: deps.rng,
      });
      if (game === null)
        return { claim: null, created: false, retryAfterSeconds: 1 };
      if (
        payload.kind === "agent" &&
        !agentMayClaim(
          game,
          humanBoardCapacity(
            games,
            config.HUMAN_BOARD_RESERVE_PERCENT,
            ctx.now,
          ),
        )
      ) {
        return { claim: null, created: false, retryAfterSeconds: 1 };
      }
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
        fenBefore: selectedView.fen,
      };
      if (payload.createGuest !== undefined) {
        deps.db
          .insert(schema.players)
          .values({
            address: payload.player,
            kind: "guest",
            nickname: null,
            createdAt: ctx.now,
            turnstileVerifiedAt: payload.createGuest.turnstileVerifiedAt,
            // Guests carry referred_by too, so link-on-login can propagate it
            // into a fresh registration (F15 step 3).
            referredBy: payload.createGuest.referredBy,
          })
          .run();
      }
      deps.db.insert(schema.claims).values(claim).run();
      ctx.appendEvent("claim_created", payload.player, { claimId: claim.id });
      ctx.afterCommit(() => {
        deps.views.setOpenClaim(claim);
        deps.views.countClaim(claim.player, claim.demo, claim.createdAt);
        deps.timers.arm(
          "claimReveal",
          claim.id,
          Math.max(
            claim.createdAt,
            claim.deadline - config.TIMER_REVEAL_SECONDS * 1_000,
          ),
        );
        deps.timers.arm("claimDeadline", claim.id, claim.deadline);
      });
      return { claim, created: true };
    },
  );

  deps.coordinator.register(
    "LinkGuest",
    (
      ctx,
      payload: {
        guest: string;
        player: string;
        inheritReferral?: boolean;
      },
    ) => {
      const guest = deps.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, payload.guest))
        .get();
      if (
        guest === undefined ||
        guest.kind !== "guest" ||
        guest.linkedAddress !== null
      )
        return { linked: false as const, claims: 0 };

      if (
        payload.inheritReferral === true &&
        guest.referredBy !== null &&
        guest.referredBy !== payload.player
      ) {
        const player = deps.db
          .select({
            kind: schema.players.kind,
            referredBy: schema.players.referredBy,
          })
          .from(schema.players)
          .where(eq(schema.players.address, payload.player))
          .get();
        const referrer = deps.db
          .select({ address: schema.players.address })
          .from(schema.players)
          .where(eq(schema.players.address, guest.referredBy))
          .get();
        if (
          player?.kind === "human" &&
          player.referredBy === null &&
          referrer !== undefined
        ) {
          deps.db
            .update(schema.players)
            .set({ referredBy: referrer.address })
            .where(eq(schema.players.address, payload.player))
            .run();
          bumpRefJoined(deps.db, referrer.address);
        }
      }

      const existingSides = loadParticipantSides(deps.db, payload.player);

      let walletHasOpen = deps.views.openClaimByPlayer.has(payload.player);
      let transferred = 0;
      const guestClaims = deps.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.player, payload.guest))
        .all();
      for (const claim of guestClaims) {
        const priorSide = existingSides.get(claim.gameId);
        if (priorSide !== undefined && priorSide !== claim.side) continue;
        if (claim.status === "open" && walletHasOpen) continue;
        if (claim.status === "expired") continue;
        deps.db
          .update(schema.claims)
          .set({ player: payload.player })
          .where(eq(schema.claims.id, claim.id))
          .run();
        existingSides.set(claim.gameId, claim.side);
        transferred += 1;
        if (claim.status === "open") {
          walletHasOpen = true;
          ctx.afterCommit(() => {
            deps.views.removeOpenClaim(claim.id);
            deps.views.setOpenClaim({ ...claim, player: payload.player });
          });
        }
      }
      deps.db
        .update(schema.players)
        .set({ linkedAddress: payload.player, linkedAt: ctx.now })
        .where(eq(schema.players.address, payload.guest))
        .run();
      return { linked: true as const, claims: transferred };
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
      const receipt = moveClaim(deps, ctx, {
        claim,
        move: payload.move,
        txid: payload.txid,
      });
      // A referral is credited once, on the referred human's qualifying staked
      // move (F15 step 4) — after moveClaim has written this move's stake entry,
      // so the count includes it. Same transaction; never touches payouts (I11).
      const cfg = deps.config();
      if (cfg.POINTS_ENABLED) {
        maybeAwardReferral(
          deps.db,
          ctx.now,
          {
            referralQualifyMoves: cfg.REFERRAL_QUALIFY_MOVES,
            referralPoints: cfg.REFERRAL_POINTS,
          },
          payload.player,
        );
      }
      if (deps.publicStats !== undefined) {
        // Public stats (F16): every settled staked move; human ones also count
        // toward humanMoves. The player-row kind is authoritative.
        const kind = deps.db
          .select({ kind: schema.players.kind })
          .from(schema.players)
          .where(eq(schema.players.address, payload.player))
          .get()?.kind;
        ctx.afterCommit(() =>
          deps.publicStats?.recordStakedMoveSettled(kind === "human"),
        );
      }
      return receipt;
    },
  );
  deps.coordinator.register(
    "ExpireClaim",
    (ctx, payload: { claimId: string }) =>
      expireClaimIfDue(deps, ctx, payload.claimId),
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
      .get(parseGameRules(game.rulesJson))
      .fromHistory(JSON.parse(game.historyJson)),
    input,
  );
}
