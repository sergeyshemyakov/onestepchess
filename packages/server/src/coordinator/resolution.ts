import {
  resolve as coreResolve,
  type GameResult,
  type ResolveEntry,
  toPgn,
} from "@onestepchess/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { bumpLedgerBalance } from "../db/ledger.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { newId } from "../ids.js";
import type { Logger } from "../logger.js";
import type { CommandContext, Coordinator } from "./queue.js";
import { parseGameRules } from "./timers.js";

export type ResolutionDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly logger: Logger;
  readonly metrics?: {
    recordGameFinished(): void;
    recordPayoutQueued(count?: number): void;
  };
  /** Injectable so a test seam can force an I4 conservation violation; the
   * server re-checks conservation independently of core before writing jobs. */
  readonly resolve?: typeof coreResolve;
};

type GameResolvedEntry =
  | {
      readonly demo: false;
      readonly side: "white" | "black";
      readonly stakeMicroUsdc: number;
      readonly payoutMicroUsdc: number;
      readonly ply: number;
    }
  | {
      readonly demo: true;
      readonly side: "white" | "black";
      readonly stakeMicroUsdc: 0;
      readonly payoutMicroUsdc: 0;
    };

export function registerResolution(deps: ResolutionDeps): void {
  const resolve = deps.resolve ?? coreResolve;
  const { db } = deps;

  deps.coordinator.register(
    "GameFinished",
    (ctx, payload: { gameId: string }) => {
      const game = db
        .select()
        .from(schema.games)
        .where(eq(schema.games.id, payload.gameId))
        .get();
      if (game === undefined) return { resolved: false as const };
      // The resolved_at marker — not the presence of jobs — is the sole
      // idempotency guard, so all-demo/zero-job games are covered too (F7).
      if (game.resolvedAt !== null) return { resolved: false as const };
      if (game.status !== "finished" && game.status !== "aborted")
        return { resolved: false as const };
      if (game.result === null)
        throw new Error(`terminal game ${game.id} has no result`);

      const stakeRows = db
        .select()
        .from(schema.stakeEntries)
        .where(eq(schema.stakeEntries.gameId, game.id))
        .all();
      const entries: ResolveEntry[] = stakeRows.map((row) => ({
        entryId: row.id,
        player: row.player,
        side: row.side,
        kind: row.kind,
        amountMicroUsdc: row.amount,
      }));
      const rules = parseGameRules(game.rulesJson);
      const resolution = resolve(entries, game.result as GameResult, rules);

      const paid = resolution.payouts.reduce(
        (sum, c) => sum + c.amountMicroUsdc,
        0,
      );
      const take =
        resolution.take.feeMicroUsdc +
        resolution.take.dustMicroUsdc +
        resolution.take.surplusMicroUsdc;
      const staked = stakeRows.reduce((sum, row) => sum + row.amount, 0);
      if (paid + take !== staked) {
        // I4 violated: write no jobs, pause with a durable cause + error row so
        // the settled stakes stay safe until a human investigates (F7 step 1).
        const cause = `conservation:${game.id}`;
        const state = db.select().from(schema.systemState).get();
        const causes: string[] =
          state === undefined
            ? []
            : (JSON.parse(state.pauseCausesJson) as string[]);
        if (!causes.includes(cause)) causes.push(cause);
        db.update(schema.systemState)
          .set({ pauseCausesJson: JSON.stringify(causes), updatedAt: ctx.now })
          .where(eq(schema.systemState.id, 1))
          .run();
        db.insert(schema.errorLog)
          .values({
            ts: ctx.now,
            level: "error",
            code: "conservation",
            requestId: null,
            contextJson: JSON.stringify({
              gameId: game.id,
              paid,
              take,
              staked,
            }),
          })
          .run();
        ctx.appendEvent("system_banner", null, {
          mode: "paused",
          banner: state?.banner ?? null,
        });
        deps.logger.error(
          { gameId: game.id, paid, take, staked },
          "resolution conservation violation — pausing",
        );
        return { resolved: false as const, paused: true as const };
      }

      const payoutByEntry = new Map<string, number>();
      for (const row of stakeRows) payoutByEntry.set(row.id, 0);
      const jobByRecipient = new Map<string, number>();
      for (const c of resolution.payouts) {
        payoutByEntry.set(
          c.entryId,
          (payoutByEntry.get(c.entryId) ?? 0) + c.amountMicroUsdc,
        );
        jobByRecipient.set(
          c.player,
          (jobByRecipient.get(c.player) ?? 0) + c.amountMicroUsdc,
        );
      }

      const reason = game.result === "aborted" ? "refund" : "resolution";
      for (const [recipient, amount] of jobByRecipient) {
        if (amount <= 0) continue;
        db.insert(schema.payoutJobs)
          .values({
            id: newId("pj_"),
            gameId: game.id,
            recipient,
            amount,
            reason,
            status: "pending",
            createdAt: ctx.now,
          })
          .run();
      }

      // Every entry's payout_amount is materialized, explicit zero included.
      for (const row of stakeRows) {
        db.update(schema.stakeEntries)
          .set({ payoutAmount: payoutByEntry.get(row.id) ?? 0 })
          .where(eq(schema.stakeEntries.id, row.id))
          .run();
      }

      // Protocol take moves treasury → protocol as paired rows; the −treasury
      // payout rows are written later, on payout confirmation (F7 step 3).
      const takes: readonly ["fee" | "dust" | "surplus", number][] = [
        ["fee", resolution.take.feeMicroUsdc],
        ["dust", resolution.take.dustMicroUsdc],
        ["surplus", resolution.take.surplusMicroUsdc],
      ];
      for (const [refType, amount] of takes) {
        if (amount <= 0) continue;
        db.insert(schema.ledger)
          .values({
            ts: ctx.now,
            account: "treasury",
            deltaMicrousdc: -amount,
            refType,
            refId: game.id,
          })
          .run();
        db.insert(schema.ledger)
          .values({
            ts: ctx.now,
            account: "protocol",
            deltaMicrousdc: amount,
            refType,
            refId: game.id,
          })
          .run();
        bumpLedgerBalance(db, "treasury", -amount);
        bumpLedgerBalance(db, "protocol", amount);
      }

      materializeReplayAndStats(db, game, stakeRows);
      emitGameResolved(db, ctx, game, stakeRows, payoutByEntry);

      // resolved_at is written last — the idempotency marker only appears once
      // every job/ledger/event row for this game is durably committed.
      db.update(schema.games)
        .set({ resolvedAt: ctx.now })
        .where(eq(schema.games.id, game.id))
        .run();

      ctx.afterCommit(() => {
        deps.metrics?.recordGameFinished();
        if (jobByRecipient.size > 0) {
          deps.metrics?.recordPayoutQueued(jobByRecipient.size);
        }
      });

      return { resolved: true as const, jobs: jobByRecipient.size };
    },
  );
}

type StoredReplayPly = {
  readonly ply: number;
  readonly side: "white" | "black";
  readonly move: { readonly uci: string; readonly san: string };
  readonly fenAfter: string;
  readonly authorAddress: string;
  readonly stakeMicroUsdc: number;
  readonly demo: boolean;
};

function materializeReplayAndStats(
  db: Db,
  game: typeof schema.games.$inferSelect,
  stakeRows: readonly (typeof schema.stakeEntries.$inferSelect)[],
): void {
  const moved = db
    .select()
    .from(schema.claims)
    .where(
      and(eq(schema.claims.gameId, game.id), eq(schema.claims.status, "moved")),
    )
    .all();
  const byPly = new Map(moved.map((claim) => [claim.movedPly, claim]));
  const history = JSON.parse(game.historyJson) as string[];
  const plies: StoredReplayPly[] = [];
  let replayComplete = true;
  for (const index of history.keys()) {
    const ply = index + 1;
    const claim = byPly.get(ply);
    if (
      claim === undefined ||
      claim.moveUci === null ||
      claim.moveSan === null ||
      claim.fenAfter === null
    ) {
      replayComplete = false;
      break;
    }
    plies.push({
      ply,
      side: claim.side,
      move: { uci: claim.moveUci, san: claim.moveSan },
      fenAfter: claim.fenAfter,
      authorAddress: claim.player,
      stakeMicroUsdc: claim.stakeMicrousdc,
      demo: claim.demo,
    });
  }
  if (replayComplete) {
    db.update(schema.games)
      .set({
        replayJson: JSON.stringify({
          plies,
          pgn: toPgn({
            history: history as import("@onestepchess/core").Uci[],
            result: game.result as GameResult,
            tags: { Event: game.name },
          }),
        }),
      })
      .where(eq(schema.games.id, game.id))
      .run();
  }

  const increments = new Map<
    string,
    { wins: number; draws: number; losses: number }
  >();
  for (const entry of stakeRows) {
    const counts = increments.get(entry.player) ?? {
      wins: 0,
      draws: 0,
      losses: 0,
    };
    if (game.result === "draw" || game.result === "aborted") counts.draws += 1;
    else if (game.result === entry.side) counts.wins += 1;
    else counts.losses += 1;
    increments.set(entry.player, counts);
  }
  for (const [player, counts] of increments) {
    db.update(schema.players)
      .set({
        wins: sql`${schema.players.wins} + ${counts.wins}`,
        draws: sql`${schema.players.draws} + ${counts.draws}`,
        losses: sql`${schema.players.losses} + ${counts.losses}`,
      })
      .where(eq(schema.players.address, player))
      .run();
  }
}

function emitGameResolved(
  db: Db,
  ctx: CommandContext,
  game: typeof schema.games.$inferSelect,
  stakeRows: readonly (typeof schema.stakeEntries.$inferSelect)[],
  payoutByEntry: ReadonlyMap<string, number>,
): void {
  const stakeByPlayer = new Map<
    string,
    (typeof schema.stakeEntries.$inferSelect)[]
  >();
  for (const row of stakeRows) {
    const list = stakeByPlayer.get(row.player) ?? [];
    list.push(row);
    stakeByPlayer.set(row.player, list);
  }

  const demoClaims = db
    .select({ player: schema.claims.player, side: schema.claims.side })
    .from(schema.claims)
    .where(
      and(
        eq(schema.claims.gameId, game.id),
        eq(schema.claims.status, "moved"),
        eq(schema.claims.demo, true),
      ),
    )
    .all();
  const demoByPlayer = new Map<string, ("white" | "black")[]>();
  for (const row of demoClaims) {
    const list = demoByPlayer.get(row.player) ?? [];
    list.push(row.side);
    demoByPlayer.set(row.player, list);
  }

  const demoOnly = [...demoByPlayer.keys()].filter(
    (player) => !stakeByPlayer.has(player),
  );
  const kinds =
    demoOnly.length === 0
      ? new Map<string, string>()
      : new Map(
          db
            .select({
              address: schema.players.address,
              kind: schema.players.kind,
            })
            .from(schema.players)
            .where(inArray(schema.players.address, demoOnly))
            .all()
            .map((row) => [row.address, row.kind]),
        );

  for (const player of new Set([
    ...stakeByPlayer.keys(),
    ...demoByPlayer.keys(),
  ])) {
    const hasStaked = stakeByPlayer.has(player);
    // I9: no game outcome ever reaches a guest — no event row is written for a
    // still-guest-owned demo participant.
    if (!hasStaked && kinds.get(player) === "guest") continue;

    const yourEntries: GameResolvedEntry[] = [];
    let total = 0;
    for (const row of stakeByPlayer.get(player) ?? []) {
      const payout = payoutByEntry.get(row.id) ?? 0;
      total += payout;
      yourEntries.push({
        demo: false,
        side: row.side,
        stakeMicroUsdc: row.amount,
        payoutMicroUsdc: payout,
        ply: row.ply,
      });
    }
    for (const side of demoByPlayer.get(player) ?? []) {
      yourEntries.push({
        demo: true,
        side,
        stakeMicroUsdc: 0,
        payoutMicroUsdc: 0,
      });
    }

    // Identity and staked-entry ply are present iff the player staked (§6.4).
    const payload = hasStaked
      ? {
          gameId: game.id,
          gameName: game.name,
          result: game.result,
          termination: game.termination,
          yourEntries,
          totalPayoutMicroUsdc: total,
        }
      : {
          result: game.result,
          termination: game.termination,
          yourEntries,
          totalPayoutMicroUsdc: total,
        };
    ctx.appendEvent("game_resolved", player, payload);
  }
}
