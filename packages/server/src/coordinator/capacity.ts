export type CapacityGame = {
  readonly status: "active" | "endspiel";
  readonly hasOpenClaim: boolean;
  readonly minNextClaimAt: number;
};

export type HumanBoardCapacity = {
  readonly totalBoards: number;
  readonly freeHumanBoards: number;
  readonly reservedHumanBoards: number;
  readonly activeBoardsAvailableToAgents: number;
};

export function humanBoardCapacity(
  games: readonly CapacityGame[],
  reservePercent: number,
  now: number,
): HumanBoardCapacity {
  // A board still inside MIN_PLY_INTERVAL_SECONDS is claimable by nobody, so
  // counting it as free would let the reserve be satisfied by boards a human
  // cannot take — leaving every actually-claimable board to the agents.
  const freeHumanBoards = games.filter(
    (game) =>
      game.status === "active" &&
      !game.hasOpenClaim &&
      now >= game.minNextClaimAt,
  ).length;
  const reservedHumanBoards = Math.ceil((games.length * reservePercent) / 100);
  return {
    totalBoards: games.length,
    freeHumanBoards,
    reservedHumanBoards,
    activeBoardsAvailableToAgents: Math.max(
      0,
      freeHumanBoards - reservedHumanBoards,
    ),
  };
}

export function agentMayClaim(
  game: CapacityGame,
  capacity: HumanBoardCapacity,
): boolean {
  return (
    game.status === "endspiel" || capacity.activeBoardsAvailableToAgents > 0
  );
}
