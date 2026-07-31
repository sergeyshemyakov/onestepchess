export type CapacityGame = {
  readonly status: "active" | "endspiel";
  readonly hasOpenClaim: boolean;
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
): HumanBoardCapacity {
  const freeHumanBoards = games.filter(
    (game) => game.status === "active" && !game.hasOpenClaim,
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
