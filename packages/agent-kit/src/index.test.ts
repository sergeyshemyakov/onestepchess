import { describe, expect, it } from "vitest";
import { toAlgebraic } from "./index.js";

describe("agent-kit placeholder", () => {
  it("formats board coordinates as algebraic squares", () => {
    expect(toAlgebraic(0, 0)).toBe("a1");
    expect(toAlgebraic(7, 7)).toBe("h8");
  });

  it("rejects out-of-range coordinates", () => {
    expect(() => toAlgebraic(8, 0)).toThrow(RangeError);
  });
});
