export const STARTING_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type Side = "white" | "black";

export function opposite(side: Side): Side {
  return side === "white" ? "black" : "white";
}
