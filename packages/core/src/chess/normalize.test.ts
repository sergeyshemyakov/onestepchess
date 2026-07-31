import { Chess } from "chess.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STARTING_FEN } from "../types.js";
import { createChess } from "./adapter.js";
import { renderAscii } from "./ascii.js";
import { toPgn } from "./pgn.js";

const CONFIG = {
  ENDSPIEL_PIECES: 10,
  REPETITION_WIN_MARGIN: 3,
  MAX_PLIES: 300,
};

describe("SAN and UCI normalization", () => {
  it("distinguishes ambiguous hints, piece case, castling, and annotations", () => {
    const game = createChess(CONFIG);
    const knights = game.fromHistory([
      "g1h3",
      "a7a6",
      "b1a3",
      "a6a5",
      "h3f4",
      "h7h6",
      "a3c4",
      "h6h5",
      "f4g6",
      "b7b6",
    ]);
    expect(game.normalizeMove(knights, "Ne5")).toMatchObject({
      ok: false,
      reason: "ambiguous",
    });
    expect(game.normalizeMove(knights, "Nge5")).toMatchObject({
      ok: true,
      move: { uci: "g6e5" },
    });

    const rooks = game.fromHistory([
      "e2e4",
      "a7a6",
      "b1c3",
      "a6a5",
      "g1f3",
      "h7h6",
      "f1c4",
      "h6h5",
      "d2d3",
      "g7g6",
      "c1e3",
      "g6g5",
      "d1d2",
      "b7b6",
      "e1e2",
      "c7c6",
      "a1b1",
      "d7d6",
      "h1g1",
      "e7e6",
    ]);
    expect(game.normalizeMove(rooks, "Re1")).toMatchObject({
      ok: false,
      reason: "ambiguous",
    });
    expect(game.normalizeMove(rooks, "Rge1")).toMatchObject({
      ok: true,
      move: { uci: "g1e1" },
    });

    const pawnAndBishop = game.fromHistory([
      "a2a4",
      "b7b5",
      "a4b5",
      "b8c6",
      "g2g3",
      "a7a6",
      "f1g2",
      "h7h6",
    ]);
    expect(game.normalizeMove(pawnAndBishop, "bxc6")).toMatchObject({
      ok: true,
      move: { uci: "b5c6" },
    });
    expect(game.normalizeMove(pawnAndBishop, "Bxc6")).toMatchObject({
      ok: true,
      move: { uci: "g2c6" },
    });

    const castle = game.fromHistory([
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1e2",
      "g8f6",
    ]);
    expect(game.normalizeMove(castle, "0-0")).toMatchObject({
      ok: true,
      move: { uci: "e1g1" },
    });
    expect(game.normalizeMove(game.initial(), "e4+!?")).toMatchObject({
      ok: true,
      move: { uci: "e2e4" },
    });

    const enPassant = game.fromHistory(["e2e4", "a7a6", "e4e5", "d7d5"]);
    expect(game.normalizeMove(enPassant, "exd6 e.p.")).toMatchObject({
      ok: true,
      move: { uci: "e5d6" },
    });
  });

  it("requires an explicit promotion in SAN and UCI", () => {
    const game = createChess(CONFIG);
    const state = game.fromHistory([
      "a2a4",
      "b7b5",
      "a4b5",
      "b8c6",
      "b5b6",
      "a7a6",
      "b6b7",
      "a6a5",
    ]);
    expect(game.normalizeMove(state, "b8")).toMatchObject({
      ok: false,
      reason: "illegal",
    });
    expect(game.normalizeMove(state, "b7b8")).toMatchObject({
      ok: false,
      reason: "illegal",
    });
    expect(game.normalizeMove(state, "b8=N")).toMatchObject({
      ok: true,
      move: { uci: "b7b8n" },
    });
    expect(game.normalizeMove(state, "b7b8q")).toMatchObject({
      ok: true,
      move: { uci: "b7b8q" },
    });
  });

  it("round-trips every generated legal move's own UCI and SAN", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { maxLength: 80 }), (choices) => {
        const game = createChess(CONFIG);
        let state = game.initial();
        for (const choice of choices) {
          const moves = game.legalMoves(state);
          if (moves.length === 0) {
            break;
          }
          const selected = moves[choice % moves.length];
          if (selected === undefined) {
            break;
          }
          expect(game.normalizeMove(state, selected.uci)).toEqual({
            ok: true,
            move: selected,
          });
          expect(game.normalizeMove(state, selected.san)).toEqual({
            ok: true,
            move: selected,
          });
          state = game.apply(state, selected);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe("canonical board and PGN rendering", () => {
  it("renders the starting position and two mid-game ASCII goldens byte-exact", () => {
    expect(renderAscii(STARTING_FEN)).toBe(
      [
        "8 r n b q k b n r",
        "7 p p p p p p p p",
        "6 . . . . . . . .",
        "5 . . . . . . . .",
        "4 . . . . . . . .",
        "3 . . . . . . . .",
        "2 P P P P P P P P",
        "1 R N B Q K B N R",
        "  a b c d e f g h",
      ].join("\n"),
    );
    const game = createChess(CONFIG);
    expect(renderAscii(game.fromHistory(["e2e4"]).fen)).toContain(
      "4 . . . . P . . .",
    );
    expect(renderAscii(game.fromHistory(["e2e4", "e7e5", "g1f3"]).fen)).toBe(
      [
        "8 r n b q k b n r",
        "7 p p p p . p p p",
        "6 . . . . . . . .",
        "5 . . . . p . . .",
        "4 . . . . P . . .",
        "3 . . . . . N . .",
        "2 P P P P . P P P",
        "1 R N B Q K B . R",
        "  a b c d e f g h",
      ].join("\n"),
    );
  });

  it("renders a deterministic PGN golden that chess.js loads", () => {
    const pgn = toPgn({
      history: ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"],
      result: "white",
      tags: { Event: "OSC", Site: "local" },
    });
    expect(pgn).toBe(
      '[Event "OSC"]\n[Site "local"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0',
    );
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
  });
});
