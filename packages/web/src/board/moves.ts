import type { Move } from "../api/schemas.js";
import { parseFenBoard, parseUci, squareIndex } from "../lib/fen.js";

// Interaction is restricted to the server's legalMoves — the browser never
// decides legality (§8.2).

/** Squares holding a piece the player may move (uci `from` squares). */
export function selectableSquares(
  legalMoves: readonly Move[],
): ReadonlySet<string> {
  return new Set(legalMoves.map((move) => parseUci(move.uci).from));
}

/** Legal target squares for a selected origin square. */
export function targetsFor(
  legalMoves: readonly Move[],
  from: string,
): readonly string[] {
  return [
    ...new Set(
      legalMoves
        .filter((move) => parseUci(move.uci).from === from)
        .map((move) => parseUci(move.uci).to),
    ),
  ];
}

/** All legal moves from → to. More than one means the UCI set requires a
 * promotion choice and must route through the picker. */
export function movesTo(
  legalMoves: readonly Move[],
  from: string,
  to: string,
): readonly Move[] {
  return legalMoves.filter((move) => {
    const parsed = parseUci(move.uci);
    return parsed.from === from && parsed.to === to;
  });
}

export type EnPassantInfo = {
  readonly targets: ReadonlySet<string>;
  readonly victims: ReadonlySet<string>;
};

/** En passant captures hiding in legalMoves: only en passant moves a pawn
 * diagonally onto an empty square. The victim pawn sits on the target file
 * at the origin rank. */
export function enPassantCaptures(
  legalMoves: readonly Move[],
  fen: string,
): EnPassantInfo {
  const board = parseFenBoard(fen);
  const targets = new Set<string>();
  const victims = new Set<string>();
  for (const move of legalMoves) {
    const { from, to } = parseUci(move.uci);
    if (from[0] === to[0]) continue;
    if (board[squareIndex(from)]?.type !== "p") continue;
    if ((board[squareIndex(to)] ?? null) !== null) continue;
    targets.add(to);
    victims.add(`${to[0]}${from[1]}`);
  }
  return { targets, victims };
}

export function needsPromotion(moves: readonly Move[]): boolean {
  return (
    moves.length > 1 &&
    moves.every((move) => parseUci(move.uci).promotion !== undefined)
  );
}
