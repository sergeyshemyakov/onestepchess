import { describe, expect, it } from "vitest";
import { totalSettled } from "./index.js";

describe("rail-mock placeholder", () => {
  it("sums settlement amounts exactly", () => {
    expect(
      totalSettled([
        { id: "a", amountMicroUsdc: 250_000n },
        { id: "b", amountMicroUsdc: 250_000n },
      ]),
    ).toBe(500_000n);
  });

  it("settles nothing when there are no settlements", () => {
    expect(totalSettled([])).toBe(0n);
  });
});
