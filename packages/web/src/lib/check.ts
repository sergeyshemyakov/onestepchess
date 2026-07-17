import {
  type Piece,
  type PieceType,
  parseFenBoard,
  type Side,
  sideToMove,
  squareName,
} from "./fen.js";

// Display-only check detection: shows the player they are in check. It never
// gates interaction — legality still comes solely from the server's
// legalMoves (§8.2).

export function kingSquare(fen: string, side: Side): string | null {
  const index = parseFenBoard(fen).findIndex(
    (piece) => piece?.type === "k" && piece.side === side,
  );
  return index === -1 ? null : squareName(index);
}

type Delta = readonly [number, number];

const KNIGHT_DELTAS: readonly Delta[] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];
const ORTHO_DELTAS: readonly Delta[] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];
const DIAG_DELTAS: readonly Delta[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Is the side to move in check? */
export function isCheck(fen: string): boolean {
  const board = parseFenBoard(fen);
  const defender = sideToMove(fen);
  const kingIndex = board.findIndex(
    (piece) => piece?.type === "k" && piece.side === defender,
  );
  if (kingIndex === -1) return false;
  const col = kingIndex % 8;
  const row = Math.floor(kingIndex / 8);

  const at = (c: number, r: number): Piece | null =>
    c < 0 || c > 7 || r < 0 || r > 7 ? null : (board[r * 8 + c] ?? null);
  const enemy = (
    c: number,
    r: number,
    types: readonly PieceType[],
  ): boolean => {
    const piece = at(c, r);
    return (
      piece !== null && piece.side !== defender && types.includes(piece.type)
    );
  };

  // Board index 0 is a8, so row grows toward rank 1: white pawns attack
  // toward smaller rows, black pawns toward larger ones.
  const pawnRow = defender === "white" ? row - 1 : row + 1;
  if (enemy(col - 1, pawnRow, ["p"]) || enemy(col + 1, pawnRow, ["p"])) {
    return true;
  }
  for (const [dc, dr] of KNIGHT_DELTAS) {
    if (enemy(col + dc, row + dr, ["n"])) return true;
  }
  for (const [dc, dr] of ORTHO_DELTAS.concat(DIAG_DELTAS)) {
    if (enemy(col + dc, row + dr, ["k"])) return true;
  }

  const slider = (
    deltas: readonly Delta[],
    types: readonly PieceType[],
  ): boolean => {
    for (const [dc, dr] of deltas) {
      let c = col + dc;
      let r = row + dr;
      while (c >= 0 && c <= 7 && r >= 0 && r <= 7) {
        const piece = at(c, r);
        if (piece !== null) {
          if (piece.side !== defender && types.includes(piece.type)) {
            return true;
          }
          break;
        }
        c += dc;
        r += dr;
      }
    }
    return false;
  };
  return slider(ORTHO_DELTAS, ["r", "q"]) || slider(DIAG_DELTAS, ["b", "q"]);
}
