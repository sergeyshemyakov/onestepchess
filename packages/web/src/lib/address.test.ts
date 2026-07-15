import { describe, expect, it } from "vitest";
import { shortenAddress } from "./address.js";

describe("web placeholder", () => {
  it("shortens a long address to head…tail", () => {
    expect(shortenAddress("ABCDEFGHIJKLMNOP")).toBe("ABCD…MNOP");
  });

  it("leaves short addresses untouched", () => {
    expect(shortenAddress("ABCD")).toBe("ABCD");
  });
});
