import { describe, expect, it } from "vitest";
import {
  fenWithoutSquare,
  parseFenBoard,
  parseUci,
  sideToMove,
  squareIndex,
  squareName,
} from "./fen.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("fen parsing", () => {
  it("maps squares to row-major indices from a8", () => {
    expect(squareIndex("a8")).toBe(0);
    expect(squareIndex("h1")).toBe(63);
    expect(squareIndex("e2")).toBe(52);
    expect(squareName(52)).toBe("e2");
  });

  it("parses the start position", () => {
    const board = parseFenBoard(START);
    expect(board[squareIndex("e1")]).toEqual({ type: "k", side: "white" });
    expect(board[squareIndex("d8")]).toEqual({ type: "q", side: "black" });
    expect(board[squareIndex("e4")]).toBeNull();
    expect(board.filter((piece) => piece !== null)).toHaveLength(32);
  });

  it("reads side to move", () => {
    expect(sideToMove(START)).toBe("white");
    expect(sideToMove(START.replace(" w ", " b "))).toBe("black");
  });

  it("parses uci moves incl. promotions", () => {
    expect(parseUci("e2e4")).toEqual({ from: "e2", to: "e4" });
    expect(parseUci("e7e8q")).toEqual({ from: "e7", to: "e8", promotion: "q" });
  });
});

describe("fenWithoutSquare", () => {
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  it("removes exactly one square and keeps the tail fields", () => {
    expect(fenWithoutSquare(START, "e2")).toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1",
    );
  });
  it("merges empty runs around the removed square", () => {
    expect(fenWithoutSquare("8/8/8/3P4/8/8/8/8 w - - 0 1", "d5")).toBe(
      "8/8/8/8/8/8/8/8 w - - 0 1",
    );
  });
});
