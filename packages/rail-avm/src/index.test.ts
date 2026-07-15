import { describe, expect, it } from "vitest";
import { isValidAlgorandAddress } from "./index.js";

describe("rail-avm placeholder", () => {
  it("accepts the Algorand zero address", () => {
    expect(
      isValidAlgorandAddress(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      ),
    ).toBe(true);
  });

  it("rejects a malformed address", () => {
    expect(isValidAlgorandAddress("not-an-address")).toBe(false);
  });
});
