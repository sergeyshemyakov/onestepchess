import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Move } from "../types.js";
import { CoreError, STARTING_FEN } from "../types.js";
import type { ChessGame, ChessState } from "./adapter.js";
import {
  createChess,
  materialPoints,
  pieceCount,
  sideToMove,
} from "./adapter.js";

const CONFIG = {
  ENDSPIEL_PIECES: 10,
  REPETITION_WIN_MARGIN: 3,
  MAX_PLIES: 300,
};

const STALEMATE = [
  "e2e3",
  "a7a5",
  "d1h5",
  "a8a6",
  "h5a5",
  "h7h5",
  "a5c7",
  "a6h6",
  "h2h4",
  "f7f6",
  "c7d7",
  "e8f7",
  "d7b7",
  "d8d3",
  "b7b8",
  "d3h7",
  "b8c8",
  "f7g6",
  "c8e6",
] as const;

const INSUFFICIENT = [
  "g1f3",
  "c7c5",
  "h2h4",
  "b7b6",
  "f3d4",
  "c5d4",
  "c2c4",
  "d4c3",
  "b1c3",
  "b8c6",
  "a2a3",
  "f7f5",
  "c3b5",
  "e7e5",
  "b5a7",
  "d8h4",
  "h1h4",
  "a8a7",
  "a1b1",
  "f8a3",
  "h4h7",
  "h8h7",
  "b2a3",
  "a7a3",
  "b1b6",
  "d7d6",
  "b6c6",
  "h7h1",
  "c6c8",
  "e8e7",
  "c1a3",
  "h1f1",
  "e1f1",
  "e5e4",
  "d1b1",
  "g8f6",
  "b1e4",
  "f6e4",
  "a3d6",
  "e7f6",
  "c8c5",
  "e4d2",
  "f1e1",
  "d2b1",
  "c5f5",
  "f6f5",
  "d6e7",
  "b1c3",
  "f2f4",
  "f5f4",
  "e7f8",
  "c3e2",
  "f8g7",
  "f4e3",
  "g7f8",
  "e2f4",
  "f8h6",
  "e3d3",
  "h6f4",
  "d3e4",
  "e1f2",
  "e4f4",
  "f2g1",
  "f4g5",
  "g1f2",
  "g5g4",
  "f2e1",
  "g4g3",
  "e1d2",
  "g3g2",
] as const;

const FIFTY_MOVE = [
  "a2a3",
  "a7a6",
  "b2b3",
  "b7b6",
  "c2c3",
  "c7c6",
  "d2d3",
  "d7d6",
  "e2e3",
  "e7e6",
  "f2f3",
  "f7f6",
  "g2g3",
  "g7g6",
  "h2h3",
  "h7h6",
  "d1c2",
  "a8a7",
  "c2b2",
  "e8d7",
  "b2a2",
  "d8e8",
  "a2g2",
  "a7b7",
  "f1e2",
  "e8f7",
  "a1a2",
  "f8g7",
  "h1h2",
  "f7e7",
  "e1d2",
  "h8h7",
  "c1b2",
  "g7f8",
  "d2c1",
  "d7d8",
  "c1d1",
  "c8d7",
  "d1c2",
  "d7c8",
  "e2f1",
  "e7g7",
  "g2e2",
  "b7f7",
  "c2d2",
  "f7a7",
  "h2f2",
  "g8e7",
  "b2a1",
  "g7g8",
  "d2c2",
  "e7d5",
  "a1b2",
  "a7a8",
  "a2a1",
  "c8d7",
  "a1a2",
  "g8g7",
  "f1g2",
  "d5e7",
  "e2d1",
  "d8c7",
  "d1e1",
  "g7f7",
  "c2d1",
  "e7c8",
  "d1c1",
  "f7e8",
  "c1d2",
  "h7g7",
  "a2a1",
  "c7d8",
  "a1a2",
  "e8f7",
  "f2f1",
  "f8e7",
  "b2c1",
  "d8e8",
  "d2d1",
  "c8a7",
  "a2d2",
  "a7b5",
  "f1f2",
  "g7g8",
  "d2a2",
  "g8g7",
  "e1e2",
  "b5a7",
  "e2b2",
  "e7d8",
  "g2f1",
  "f7e7",
  "b1d2",
  "e8f8",
  "b2a1",
  "f8e8",
  "d1c2",
  "a7b5",
  "c2b2",
  "g7h7",
  "g1e2",
  "b5c7",
  "d2b1",
  "e7g7",
  "e2d4",
  "h7h8",
  "d4e2",
  "c7b5",
  "e2f4",
  "h8f8",
  "f2d2",
  "b5c7",
  "d2e2",
  "g7f7",
  "b1d2",
  "c7b5",
] as const;

function playChoices(game: ChessGame, choices: readonly number[]): ChessState {
  let state = game.initial();
  for (const choice of choices) {
    const moves = game.legalMoves(state);
    if (moves.length === 0) {
      break;
    }
    const move = moves[choice % moves.length];
    if (move === undefined) {
      break;
    }
    state = game.apply(state, move);
  }
  return state;
}

describe("chess adapter fixtures", () => {
  it("supports castling on both sides and permanently loses moved-king rights", () => {
    const game = createChess(CONFIG);
    const castled = game.fromHistory([
      "e2e4",
      "e7e5",
      "g1f3",
      "b8c6",
      "f1e2",
      "g8f6",
      "e1g1",
      "f8e7",
      "d2d3",
      "e8g8",
    ]);
    expect(castled.fen.split(" ")[2]).toBe("-");

    const whiteTurn = game.fromHistory([
      "e2e4",
      "e7e5",
      "e1e2",
      "e8e7",
      "e2e1",
      "e7e8",
      "g1f3",
      "b8c6",
      "f1e2",
      "g8f6",
    ]);
    expect(game.legalMoves(whiteTurn).map((move) => move.uci)).not.toContain(
      "e1g1",
    );
    const blackTurn = game.apply(
      whiteTurn,
      game.legalMoves(whiteTurn).find((move) => move.uci === "d2d3") as Move,
    );
    expect(game.legalMoves(blackTurn).map((move) => move.uci)).not.toContain(
      "e8g8",
    );
  });

  it("supports en passant creation and expiry", () => {
    const game = createChess(CONFIG);
    const created = game.fromHistory(["e2e4", "a7a6", "e4e5", "d7d5"]);
    expect(game.legalMoves(created).map((move) => move.uci)).toContain("e5d6");
    const expired = game.fromHistory([
      "e2e4",
      "a7a6",
      "e4e5",
      "d7d5",
      "h2h3",
      "a6a5",
    ]);
    expect(game.legalMoves(expired).map((move) => move.uci)).not.toContain(
      "e5d6",
    );
  });

  it("offers every promotion including under-promotion", () => {
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
    expect(game.legalMoves(state).map((move) => move.uci)).toEqual(
      expect.arrayContaining(["b7b8q", "b7b8r", "b7b8b", "b7b8n"]),
    );
  });

  it("classifies every termination kind and honors the pinned precedence", () => {
    const game = createChess({ ...CONFIG, MAX_PLIES: 1_000 });
    const fixtures = [
      {
        history: ["f2f3", "e7e5", "g2g4", "d8h4"],
        termination: "checkmate",
      },
      { history: STALEMATE, termination: "stalemate" },
      { history: INSUFFICIENT, termination: "insufficient" },
      {
        history: [
          "g1f3",
          "g8f6",
          "f3g1",
          "f6g8",
          "g1f3",
          "g8f6",
          "f3g1",
          "f6g8",
        ],
        termination: "threefold",
      },
      { history: FIFTY_MOVE, termination: "fifty_move" },
    ] as const;
    for (const fixture of fixtures) {
      expect(game.terminal(game.fromHistory(fixture.history))).toMatchObject({
        over: true,
        termination: fixture.termination,
      });
    }

    const maxGame = createChess({ ...CONFIG, MAX_PLIES: 4 });
    expect(
      maxGame.terminal(maxGame.fromHistory(["g1f3", "g8f6", "f3g1", "f6g8"])),
    ).toEqual({ over: true, result: "draw", termination: "max_plies" });

    const precedence = createChess({ ...CONFIG, MAX_PLIES: 1 });
    expect(
      precedence.terminal(precedence.fromHistory(FIFTY_MOVE)),
    ).toMatchObject({
      termination: "fifty_move",
    });
    expect(
      precedence.terminal(precedence.fromHistory(INSUFFICIENT)),
    ).toMatchObject({
      termination: "insufficient",
    });
  });

  it("awards a threefold repetition to a side leading by the configured material margin", () => {
    const game = createChess(CONFIG);
    const state = game.fromHistory([
      "f2f3",
      "e7e5",
      "g2g3",
      "d8h4",
      "g3h4",
      "g8f6",
      "g1h3",
      "f6g8",
      "h3g1",
      "g8f6",
      "g1h3",
      "f6g8",
      "h3g1",
    ]);

    expect(game.materialPoints(state.fen)).toEqual({ white: 39, black: 30 });
    expect(game.terminal(state)).toEqual({
      over: true,
      result: "white",
      termination: "threefold",
    });
  });

  it("keeps a threefold repetition drawn below the configured material margin", () => {
    const history = [
      "e2e4",
      "d7d5",
      "e4d5",
      "g8f6",
      "g1f3",
      "f6g8",
      "f3g1",
      "g8f6",
      "g1f3",
      "f6g8",
      "f3g1",
    ];
    const state = createChess(CONFIG).fromHistory(history);

    expect(createChess(CONFIG).terminal(state)).toEqual({
      over: true,
      result: "draw",
      termination: "threefold",
    });
    expect(
      createChess({ ...CONFIG, REPETITION_WIN_MARGIN: 1 }).terminal(state),
    ).toEqual({
      over: true,
      result: "white",
      termination: "threefold",
    });
  });

  it("fires the max-plies adjudicated draw at exactly the configured boundary", () => {
    const game = createChess({ ...CONFIG, MAX_PLIES: 4 });
    expect(game.terminal(game.fromHistory(["g1f3", "g8f6", "f3g1"]))).toEqual({
      over: false,
    });
    expect(
      game.terminal(game.fromHistory(["g1f3", "g8f6", "f3g1", "f6g8"])),
    ).toMatchObject({ over: true, termination: "max_plies" });
  });

  it("switches phase only at the piece-count boundary", () => {
    const game = createChess({
      ENDSPIEL_PIECES: 10,
      REPETITION_WIN_MARGIN: 3,
      MAX_PLIES: 300,
    });
    expect(game.phase(game.initial())).toBe("normal");
    expect(
      game.phase({
        fen: STARTING_FEN,
        history: Array.from({ length: 60 }, () => "g1f3"),
      }),
    ).toBe("normal");
    expect(
      game.phase({
        fen: "r3k3/8/8/8/8/ppp5/PPP5/R3K2R w KQ - 0 1",
        history: [],
      }),
    ).toBe("normal");
    expect(
      game.phase({
        fen: "4k3/8/8/8/8/ppp5/PPP5/R3K2R w KQ - 0 1",
        history: [],
      }),
    ).toBe("endspiel");
  });

  it("counts pieces on sparse boards with both kings included", () => {
    expect(pieceCount("8/8/8/8/8/8/4k3/4K3 w - - 0 1")).toBe(2);
    expect(pieceCount("8/8/8/3q4/8/8/4k3/4K2R w - - 0 1")).toBe(4);
  });

  it("scores material with standard values and excludes kings", () => {
    expect(materialPoints("4k3/8/8/3q4/8/2N5/P7/4K2R w - - 0 1")).toEqual({
      white: 9,
      black: 9,
    });
  });

  it("keeps sideToMove and corrupt-history errors inside the core contract", () => {
    expect(sideToMove(STARTING_FEN)).toBe("white");
    expect(() => sideToMove("garbage")).toThrow(CoreError);
    expect(() => createChess(CONFIG).fromHistory(["e2e5"])).toThrowError(
      expect.objectContaining({ code: "CORRUPT_HISTORY" }),
    );
  });
});

describe("chess adapter properties and performance", () => {
  it("applies every generated legal move and keeps ordering stable and sorted", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { maxLength: 60 }), (choices) => {
        const game = createChess(CONFIG);
        const state = playChoices(game, choices);
        const moves = game.legalMoves(state);
        expect(moves.map((move) => move.uci)).toEqual(
          [...moves].map((move) => move.uci).sort(),
        );
        for (const move of moves) {
          expect(() => game.apply(state, move)).not.toThrow();
        }
      }),
      { numRuns: 60 },
    );
  });

  it("replays history exactly and makes cached behavior equal replay-from-scratch", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { maxLength: 80 }), (choices) => {
        const cached = createChess(CONFIG, { cacheSize: 64 });
        const replayed = createChess(CONFIG, { cacheSize: 0 });
        const state = playChoices(cached, choices);
        const uciHistory = cached.history(state).map((move) => move.uci);
        const rebuilt = replayed.fromHistory(uciHistory);
        expect(replayed.encode(rebuilt)).toBe(cached.encode(state));
        expect(replayed.legalMoves(rebuilt)).toEqual(cached.legalMoves(state));
        expect(replayed.terminal(rebuilt)).toEqual(cached.terminal(state));
      }),
      { numRuns: 50 },
    );
  });

  it("keeps exported chess signatures expressed only in core types", () => {
    type ApplyArgs = Parameters<ChessGame["apply"]>;
    type Expected = [state: ChessState, move: Move];
    const assertion: ApplyArgs extends Expected ? true : false = true;
    expect(assertion).toBe(true);
  });

  it("applies a sequential 300-ply game within the amortized budget", () => {
    const game = createChess({ ...CONFIG, MAX_PLIES: 1_000 });
    let state = game.initial();
    const cycle = ["g1f3", "g8f6", "f3g1", "f6g8"] as const;
    const startedAt = performance.now();
    for (let ply = 0; ply < 300; ply += 1) {
      const uci = cycle[ply % cycle.length];
      state = game.apply(state, { uci: uci as string, san: "" });
    }
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});
