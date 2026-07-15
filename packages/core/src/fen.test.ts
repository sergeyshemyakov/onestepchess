import { describe, expect, it } from "vitest";
import { STARTING_FEN, sideToMove } from "./index.js";

describe("sideToMove", () => {
  it("reads white to move from the starting position", () => {
    expect(sideToMove(STARTING_FEN)).toBe("white");
  });

  it("reads black to move after white's first move", () => {
    expect(
      sideToMove("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"),
    ).toBe("black");
  });

  it("rejects a FEN without a side-to-move field", () => {
    expect(() => sideToMove("garbage")).toThrow("invalid FEN");
  });
});
