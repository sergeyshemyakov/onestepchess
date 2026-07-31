import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { apiUrl } from "./index.js";

describe("e2e workspace", () => {
  it("joins base and path into an absolute URL", () => {
    expect(apiUrl("http://localhost:3000", "/api/v1/health")).toBe(
      "http://localhost:3000/api/v1/health",
    );
  });

  it("t1_chain_smoke_is_explicit_and_absent_from_ci", async () => {
    const ci = await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    expect(ci).not.toContain("smoke:t1");
    expect(ci).not.toContain("t1-chain-smoke");
    expect(ci).not.toContain("smoke:release4:testnet");
    expect(ci).not.toContain("smoke:release4:mainnet");
    expect(ci).not.toContain("release4-chain-smoke");
  });
});
