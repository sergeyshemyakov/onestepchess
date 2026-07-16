import { createChess } from "../chess/adapter.js";
import type { CoreConfig, GameRules } from "../config.js";
import { resolve } from "../payout/resolve.js";
import {
  type ClaimStatus,
  CoreError,
  type EpochMs,
  type GameResult,
  type GameStatus,
  type IntentStatus,
  type MicroUsdc,
  type PayoutStatus,
  type Side,
  type StakeKind,
  type Termination,
  type Uci,
} from "../types.js";

export type DomainSnapshot = {
  readonly cfg: CoreConfig;
  readonly games: readonly {
    readonly id: string;
    readonly status: GameStatus;
    readonly fen: string;
    readonly ply: number;
    readonly rules: GameRules;
    readonly history: readonly Uci[];
    readonly result: GameResult | null;
    readonly termination: Termination | null;
    readonly endspielPly: number | null;
    readonly minNextClaimAt: EpochMs;
    readonly lastPlyAt: EpochMs;
    readonly resolvedAt: EpochMs | null;
  }[];
  readonly claims: readonly {
    readonly id: string;
    readonly gameId: string;
    readonly player: string;
    readonly side: Side;
    readonly demo: boolean;
    readonly stakeMicroUsdc: MicroUsdc;
    readonly status: ClaimStatus;
    readonly deadline: EpochMs;
    readonly movedPly: number | null;
  }[];
  readonly stakeEntries: readonly {
    readonly id: string;
    readonly gameId: string;
    readonly claimId: string;
    readonly player: string;
    readonly side: Side;
    readonly kind: StakeKind;
    readonly amountMicroUsdc: MicroUsdc;
    readonly ply: number;
    readonly payoutMicroUsdc: MicroUsdc | null;
  }[];
  readonly paymentIntents: readonly {
    readonly id: string;
    readonly claimId: string;
    readonly status: IntentStatus;
    readonly amountMicroUsdc: MicroUsdc;
  }[];
  readonly payoutJobs: readonly {
    readonly gameId: string;
    readonly recipient: string;
    readonly amountMicroUsdc: MicroUsdc;
    readonly reason: "resolution" | "refund";
    readonly status: PayoutStatus;
  }[];
};

export type InvariantViolation = {
  readonly code: string;
  readonly message: string;
  readonly refs: readonly string[];
};

function isTerminal(status: GameStatus): boolean {
  return status === "finished" || status === "aborted";
}

const DRAW_TERMINATIONS: readonly Termination[] = [
  "stalemate",
  "insufficient",
  "threefold",
  "fifty_move",
  "max_plies",
];

/** Pure invariant checks over a neutral snapshot; time-relative conditions
 * (overdue expiries) are deliberately excluded — mid-processing snapshots
 * are legal. Empty result = clean; callers decide throw-vs-report. */
export function checkDomainInvariants(
  s: DomainSnapshot,
  opts?: { verifyFens?: boolean },
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const report = (code: string, message: string, refs: string[]): void => {
    violations.push({ code, message, refs });
  };

  const gamesById = new Map(s.games.map((g) => [g.id, g]));
  const claimsById = new Map(s.claims.map((c) => [c.id, c]));
  const entriesByGame = new Map<
    string,
    DomainSnapshot["stakeEntries"][number][]
  >();
  for (const entry of s.stakeEntries) {
    const rows = entriesByGame.get(entry.gameId);
    if (rows === undefined) {
      entriesByGame.set(entry.gameId, [entry]);
    } else {
      rows.push(entry);
    }
  }
  const jobsByGame = new Map<string, DomainSnapshot["payoutJobs"][number][]>();
  for (const job of s.payoutJobs) {
    const rows = jobsByGame.get(job.gameId);
    if (rows === undefined) {
      jobsByGame.set(job.gameId, [job]);
    } else {
      rows.push(job);
    }
  }

  // K1 (I1): claim uniqueness per game and per player
  const openByGame = new Map<string, string[]>();
  const openByPlayer = new Map<string, string[]>();
  for (const claim of s.claims) {
    if (claim.status === "open") {
      const byGame = openByGame.get(claim.gameId);
      if (byGame === undefined) {
        openByGame.set(claim.gameId, [claim.id]);
      } else {
        byGame.push(claim.id);
      }
      const byPlayer = openByPlayer.get(claim.player);
      if (byPlayer === undefined) {
        openByPlayer.set(claim.player, [claim.id]);
      } else {
        byPlayer.push(claim.id);
      }
    }
  }
  for (const [gameId, claimIds] of openByGame) {
    if (claimIds.length > 1) {
      report("K1", "more than one open claim on a game", [gameId, ...claimIds]);
    }
  }
  for (const [player, claimIds] of openByPlayer) {
    if (claimIds.length > 1) {
      report("K1", "more than one open claim for a player", [
        player,
        ...claimIds,
      ]);
    }
  }

  // K2 (I2): per (game, player) all stake entries and moved claims on one side
  const sidesByGamePlayer = new Map<string, Map<string, Side>>();
  const addSide = (gameId: string, player: string, side: Side): void => {
    let byPlayer = sidesByGamePlayer.get(gameId);
    if (byPlayer === undefined) {
      byPlayer = new Map();
      sidesByGamePlayer.set(gameId, byPlayer);
    }
    const seen = byPlayer.get(player);
    if (seen === undefined) {
      byPlayer.set(player, side);
    } else if (seen !== side) {
      report("K2", "player participated on both sides of one game", [
        gameId,
        player,
      ]);
      byPlayer.set(player, side);
    }
  };
  for (const entry of s.stakeEntries) {
    addSide(entry.gameId, entry.player, entry.side);
  }
  for (const claim of s.claims) {
    if (claim.status === "moved") {
      addSide(claim.gameId, claim.player, claim.side);
    }
  }

  // K3 (I3): settled ⇔ moved, in-flight lock
  const settledByClaim = new Map<string, number>();
  const inFlightByClaim = new Map<string, number>();
  for (const intent of s.paymentIntents) {
    if (intent.status === "settled") {
      settledByClaim.set(
        intent.claimId,
        (settledByClaim.get(intent.claimId) ?? 0) + 1,
      );
      const claim = claimsById.get(intent.claimId);
      if (claim === undefined || claim.status !== "moved") {
        report("K3", "settled intent on a claim that is not moved", [
          intent.id,
          intent.claimId,
        ]);
      }
    }
    if (intent.status === "verified" || intent.status === "settling") {
      inFlightByClaim.set(
        intent.claimId,
        (inFlightByClaim.get(intent.claimId) ?? 0) + 1,
      );
    }
  }
  for (const claim of s.claims) {
    if (
      claim.status === "moved" &&
      !claim.demo &&
      (settledByClaim.get(claim.id) ?? 0) !== 1
    ) {
      report("K3", "moved non-demo claim without exactly one settled intent", [
        claim.id,
      ]);
    }
  }
  for (const [claimId, count] of inFlightByClaim) {
    if (count > 1) {
      report("K3", "more than one in-flight intent on a claim", [claimId]);
    }
  }

  // K4 (I4/I5/I6): differential resolve() recompute vs materialized payouts/jobs
  for (const game of s.games) {
    const entries = entriesByGame.get(game.id) ?? [];
    const jobs = jobsByGame.get(game.id) ?? [];
    const resolved =
      isTerminal(game.status) &&
      game.resolvedAt !== null &&
      game.result !== null;
    if (!resolved) {
      for (const entry of entries) {
        if (entry.payoutMicroUsdc !== null) {
          report("K4", "materialized payout on an unresolved game", [
            game.id,
            entry.id,
          ]);
        }
      }
      if (jobs.length > 0) {
        report("K4", "payout jobs on an unresolved game", [game.id]);
      }
      continue;
    }
    const recomputed = resolve(
      entries.map((e) => ({
        entryId: e.id,
        player: e.player,
        side: e.side,
        kind: e.kind,
        amountMicroUsdc: e.amountMicroUsdc,
      })),
      game.result as GameResult,
      game.rules,
    );
    const byEntry = new Map<string, number>();
    const byRecipient = new Map<string, number>();
    for (const component of recomputed.payouts) {
      byEntry.set(
        component.entryId,
        (byEntry.get(component.entryId) ?? 0) + component.amountMicroUsdc,
      );
      byRecipient.set(
        component.player,
        (byRecipient.get(component.player) ?? 0) + component.amountMicroUsdc,
      );
    }
    for (const entry of entries) {
      if (entry.payoutMicroUsdc !== (byEntry.get(entry.id) ?? 0)) {
        report("K4", "materialized entry payout differs from resolve()", [
          game.id,
          entry.id,
        ]);
      }
    }
    for (const [recipient, expected] of byRecipient) {
      if (expected === 0) {
        continue;
      }
      const matching = jobs.filter((j) => j.recipient === recipient);
      if (matching.length !== 1 || matching[0]?.amountMicroUsdc !== expected) {
        report("K4", "payout jobs differ from resolve() for a recipient", [
          game.id,
          recipient,
        ]);
      }
    }
    for (const job of jobs) {
      if ((byRecipient.get(job.recipient) ?? 0) === 0) {
        report("K4", "payout job for a recipient resolve() does not pay", [
          game.id,
          job.recipient,
        ]);
      }
    }
  }

  // K5: terminal result/termination consistency
  for (const game of s.games) {
    if (isTerminal(game.status)) {
      if (game.result === null || game.termination === null) {
        report("K5", "terminal game without result or termination", [game.id]);
        continue;
      }
      const aborted =
        game.result === "aborted" || game.termination === "aborted";
      if (aborted !== (game.status === "aborted")) {
        report("K5", "aborted status inconsistent with result/termination", [
          game.id,
        ]);
      } else if (
        game.termination === "checkmate" &&
        game.result !== "white" &&
        game.result !== "black"
      ) {
        report("K5", "checkmate without a decisive result", [game.id]);
      } else if (
        DRAW_TERMINATIONS.includes(game.termination) &&
        game.result !== "draw"
      ) {
        report("K5", "draw termination without a draw result", [game.id]);
      }
    } else if (game.result !== null || game.termination !== null) {
      report("K5", "non-terminal game with result or termination", [game.id]);
    }
  }

  // K6: endspiel-ply consistency
  for (const game of s.games) {
    if (game.status === "active" && game.endspielPly !== null) {
      report("K6", "active game with endspielPly set", [game.id]);
    }
    if (game.status === "endspiel" && game.endspielPly === null) {
      report("K6", "endspiel game without endspielPly", [game.id]);
    }
    if (game.endspielPly !== null && game.endspielPly > game.ply) {
      report("K6", "endspielPly above the game ply", [game.id]);
    }
  }

  // K7: claim field consistency
  for (const claim of s.claims) {
    if (claim.status === "moved" && claim.movedPly === null) {
      report("K7", "moved claim without movedPly", [claim.id]);
    }
    if (claim.status === "open") {
      const game = gamesById.get(claim.gameId);
      if (game === undefined || isTerminal(game.status)) {
        report("K7", "open claim on a missing or terminal game", [
          claim.id,
          claim.gameId,
        ]);
      }
    }
    if (claim.demo !== (claim.stakeMicroUsdc === 0)) {
      report("K7", "demo flag inconsistent with a zero stake", [claim.id]);
    }
  }

  // K8: stake-entry consistency
  for (const entry of s.stakeEntries) {
    const claim = claimsById.get(entry.claimId);
    if (claim === undefined) {
      report("K8", "stake entry without a parent claim", [
        entry.id,
        entry.claimId,
      ]);
    } else {
      if (claim.status !== "moved" || claim.demo) {
        report("K8", "stake entry on a claim that is not moved and non-demo", [
          entry.id,
          claim.id,
        ]);
      }
      if (entry.amountMicroUsdc !== claim.stakeMicroUsdc) {
        report("K8", "stake entry amount differs from the claim stake", [
          entry.id,
          claim.id,
        ]);
      }
    }
    const game = gamesById.get(entry.gameId);
    if (game === undefined) {
      report("K8", "stake entry without a parent game", [
        entry.id,
        entry.gameId,
      ]);
    } else if (entry.ply > game.ply) {
      report("K8", "stake entry ply above the game ply", [entry.id, game.id]);
    }
  }

  // K9 (opt-in): history replay reproduces fen and ply
  if (opts?.verifyFens === true) {
    for (const game of s.games) {
      try {
        const replayed = createChess(game.rules, { cacheSize: 0 }).fromHistory(
          game.history,
        );
        if (replayed.fen !== game.fen || game.ply !== game.history.length) {
          report("K9", "history replay does not reproduce fen/ply", [game.id]);
        }
      } catch (error) {
        if (error instanceof CoreError) {
          report("K9", "history does not replay", [game.id]);
        } else {
          throw error;
        }
      }
    }
  }

  return violations;
}
