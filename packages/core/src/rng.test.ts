import { describe, expect, it } from "vitest";
import { createRng } from "./rng.js";

describe("createRng", () => {
  it("matches the fixed-seed mulberry32 golden sequence", () => {
    const rng = createRng(1);
    expect(Array.from({ length: 5 }, () => rng())).toEqual(
      [
        2_693_262_067, 11_749_833, 2_265_367_787, 4_213_581_821, 4_159_151_403,
      ].map((value) => value / 4_294_967_296),
    );
  });

  it("produces identical sequences forever from the same seed", () => {
    const first = createRng(0xdecafbad);
    const second = createRng(0xdecafbad);
    for (let index = 0; index < 10_000; index += 1) {
      expect(first()).toBe(second());
    }
  });
});
