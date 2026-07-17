import { describe, expect, it } from "vitest";
import { enPassantCaptures } from "./moves.js";

// White pawn e5, black just played d7d5 — exd6 e.p. is legal.
const EP_WHITE_FEN =
  "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
// Black pawn d4, white just played e2e4 — dxe3 e.p. is legal.
const EP_BLACK_FEN =
  "rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3";

describe("enPassantCaptures", () => {
  it("finds the en passant target and the victim pawn for white", () => {
    const ep = enPassantCaptures(
      [
        { uci: "e5d6", san: "exd6" },
        { uci: "e5e6", san: "e6" },
        { uci: "g1f3", san: "Nf3" },
      ],
      EP_WHITE_FEN,
    );
    expect([...ep.targets]).toEqual(["d6"]);
    expect([...ep.victims]).toEqual(["d5"]);
  });

  it("finds the en passant target and the victim pawn for black", () => {
    const ep = enPassantCaptures([{ uci: "d4e3", san: "dxe3" }], EP_BLACK_FEN);
    expect([...ep.targets]).toEqual(["e3"]);
    expect([...ep.victims]).toEqual(["e4"]);
  });

  it("ignores ordinary pawn captures onto occupied squares", () => {
    // White pawn e4 can capture the black pawn on d5 normally.
    const ep = enPassantCaptures(
      [{ uci: "e4d5", san: "exd5" }],
      "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    );
    expect(ep.targets.size).toBe(0);
    expect(ep.victims.size).toBe(0);
  });

  it("ignores quiet pawn pushes and non-pawn diagonal moves to empty squares", () => {
    const ep = enPassantCaptures(
      [
        { uci: "d2d4", san: "d4" },
        { uci: "f1c4", san: "Bc4" },
      ],
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1",
    );
    expect(ep.targets.size).toBe(0);
    expect(ep.victims.size).toBe(0);
  });
});
