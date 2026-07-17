// Minimal FEN/UCI reading for rendering and interaction. The browser never
// runs a chess engine — legality always comes from the server's legalMoves.

export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
export type Side = "white" | "black";

export type Piece = {
  readonly type: PieceType;
  readonly side: Side;
};

export const FILES = "abcdefgh";

/** "e2" → board index (0 = a8, row-major from the top). */
export function squareIndex(square: string): number {
  return (8 - Number(square[1])) * 8 + FILES.indexOf(square[0] ?? "");
}

/** board index → "e2". */
export function squareName(index: number): string {
  return `${FILES[index % 8]}${8 - Math.floor(index / 8)}`;
}

/** FEN placement field → 64-entry array, index 0 = a8. */
export function parseFenBoard(fen: string): readonly (Piece | null)[] {
  const board: (Piece | null)[] = Array(64).fill(null);
  const placement = fen.split(" ")[0] ?? "";
  let index = 0;
  for (const ch of placement) {
    if (ch === "/") continue;
    if (ch >= "1" && ch <= "8") {
      index += Number(ch);
      continue;
    }
    const lower = ch.toLowerCase() as PieceType;
    if ("pnbrqk".includes(lower) && index < 64) {
      board[index] = { type: lower, side: ch === lower ? "black" : "white" };
      index += 1;
    }
  }
  return board;
}

export function sideToMove(fen: string): Side {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

export type UciMove = {
  readonly from: string;
  readonly to: string;
  readonly promotion?: string;
};

export function parseUci(uci: string): UciMove {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci.slice(4) } : {}),
  };
}
