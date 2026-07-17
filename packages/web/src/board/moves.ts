import type { Move } from "../api/schemas.js";
import { parseUci } from "../lib/fen.js";

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

export function needsPromotion(moves: readonly Move[]): boolean {
  return (
    moves.length > 1 &&
    moves.every((move) => parseUci(move.uci).promotion !== undefined)
  );
}
