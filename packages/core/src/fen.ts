import type { Side } from "./index.js";

export function sideToMove(fen: string): Side {
  const field = fen.split(" ")[1];
  if (field === "w") {
    return "white";
  }
  if (field === "b") {
    return "black";
  }
  throw new Error("invalid FEN: missing side-to-move field");
}
