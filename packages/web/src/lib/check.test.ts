import { describe, expect, it } from "vitest";
import { isCheck, kingSquare } from "./check.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("kingSquare", () => {
  it("finds each side's king in the start position", () => {
    expect(kingSquare(START, "white")).toBe("e1");
    expect(kingSquare(START, "black")).toBe("e8");
  });
});

describe("isCheck (display-only)", () => {
  it("reports no check in the start position", () => {
    expect(isCheck(START)).toBe(false);
  });

  it("sees a rook check along an open file", () => {
    expect(isCheck("4k3/8/8/8/8/8/8/4RK2 b - - 0 1")).toBe(true);
  });

  it("sees no check when the ray is blocked", () => {
    expect(isCheck("4k3/4p3/8/8/8/8/8/4RK2 b - - 0 1")).toBe(false);
  });

  it("sees a knight check", () => {
    expect(isCheck("4k3/8/3N4/8/8/8/8/4K3 b - - 0 1")).toBe(true);
  });

  it("sees a diagonal queen check", () => {
    expect(isCheck("4k3/8/8/8/Q7/8/8/4K3 b - - 0 1")).toBe(true);
  });

  it("sees a pawn check only on the pawn's capture diagonals", () => {
    expect(isCheck("4k3/3P4/8/8/8/8/8/4K3 b - - 0 1")).toBe(true);
    expect(isCheck("4k3/4P3/8/8/8/8/8/4K3 b - - 0 1")).toBe(false);
  });

  it("checks the side to move, not the other king", () => {
    expect(isCheck("4k3/8/8/8/8/8/8/r3K3 w - - 0 1")).toBe(true);
    expect(isCheck("4k3/8/8/8/8/8/8/r3K3 b - - 0 1")).toBe(false);
  });
});
