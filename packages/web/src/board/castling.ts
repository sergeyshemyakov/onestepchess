export type CastlingRookMove = {
  readonly from: string;
  readonly to: string;
};

const ROOK_MOVES: Readonly<Record<string, CastlingRookMove>> = {
  e1g1: { from: "h1", to: "f1" },
  e1c1: { from: "a1", to: "d1" },
  e8g8: { from: "h8", to: "f8" },
  e8c8: { from: "a8", to: "d8" },
};

export function castlingRookMove(
  kingFrom: string,
  kingTo: string,
): CastlingRookMove | null {
  return ROOK_MOVES[`${kingFrom}${kingTo}`] ?? null;
}
