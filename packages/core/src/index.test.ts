import { Chess } from "chess.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { opposite, STARTING_FEN } from "./index.js";

describe("core placeholder domain", () => {
  it("STARTING_FEN matches the chess.js initial position", () => {
    expect(new Chess().fen()).toBe(STARTING_FEN);
  });

  it("opposite is an involution over sides", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("white" as const, "black" as const),
        (side) => {
          expect(opposite(opposite(side))).toBe(side);
        },
      ),
    );
  });
});
