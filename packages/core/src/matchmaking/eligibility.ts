import { sideToMove } from "../chess/adapter.js";
import type { EpochMs, PlayerKind, Side } from "../types.js";

export type CandidateGame = {
  readonly id: string;
  readonly status: "active" | "endspiel";
  readonly fen: string;
  readonly ply: number;
  readonly minNextClaimAt: EpochMs;
  readonly lastPlyAt: EpochMs;
  readonly hasOpenClaim: boolean;
  readonly cooldownPlies: number;
};

export type Participation = {
  readonly gameId: string;
  readonly side: Side;
  readonly lastPly: number;
};

export function eligibleGames(args: {
  games: readonly CandidateGame[];
  requesterKind: PlayerKind;
  participation: readonly Participation[];
  now: EpochMs;
}): CandidateGame[] {
  const { games, requesterKind, participation, now } = args;
  return games.filter((game) => {
    if (
      game.status !== "active" &&
      !(game.status === "endspiel" && requesterKind === "agent")
    ) {
      return false;
    }
    if (game.hasOpenClaim || now < game.minNextClaimAt) {
      return false;
    }
    const played = participation.find((row) => row.gameId === game.id);
    if (played === undefined) {
      return true;
    }
    return (
      sideToMove(game.fen) === played.side &&
      game.ply - played.lastPly >= game.cooldownPlies
    );
  });
}
