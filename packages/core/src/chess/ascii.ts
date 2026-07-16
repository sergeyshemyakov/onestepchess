import { Chess } from "chess.js";
import { CoreError } from "../types.js";

export function renderAscii(fen: string): string {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    throw new CoreError("CONTRACT", "invalid FEN");
  }

  const ranks = chess.board().map((rank, index) => {
    const pieces = rank.map((piece) => {
      if (piece === null) {
        return ".";
      }
      return piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    });
    return `${8 - index} ${pieces.join(" ")}`;
  });
  return [...ranks, "  a b c d e f g h"].join("\n");
}
