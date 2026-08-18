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

/** FEN with one square emptied — the board loop renders the claim position
 * minus the mover so the overlay piece never duplicates it. */
export function fenWithoutSquare(fen: string, square: string): string {
  const board = [...parseFenBoard(fen)];
  board[squareIndex(square)] = null;
  const rows: string[] = [];
  for (let rank = 0; rank < 8; rank += 1) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = board[rank * 8 + file];
      if (piece === null || piece === undefined) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += piece.side === "white" ? piece.type.toUpperCase() : piece.type;
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return [rows.join("/"), ...fen.split(" ").slice(1)].join(" ");
}

const START_COUNTS: Record<PieceType, number> = {
  p: 8,
  n: 2,
  b: 2,
  r: 2,
  q: 1,
  k: 1,
};

/** Value order for displaying captures — queen first, pawns last. */
const CAPTURE_ORDER: readonly PieceType[] = ["q", "r", "b", "n", "p"];

/** Pieces of `side` missing from the board versus the starting set, sorted by
 * value descending. FEN-only approximation (no move history is exposed): a
 * promoted pawn shows as a captured pawn and surplus promoted pieces clamp
 * at zero instead of going negative. */
export function capturedPieces(fen: string, side: Side): readonly PieceType[] {
  const counts: Record<PieceType, number> = {
    p: 0,
    n: 0,
    b: 0,
    r: 0,
    q: 0,
    k: 0,
  };
  for (const piece of parseFenBoard(fen)) {
    if (piece !== null && piece.side === side) counts[piece.type] += 1;
  }
  const captured: PieceType[] = [];
  for (const type of CAPTURE_ORDER) {
    for (let index = counts[type]; index < START_COUNTS[type]; index += 1) {
      captured.push(type);
    }
  }
  return captured;
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
