import { describe, expect, it, vi } from "vitest";
import { createAvmRail, type RailDiagnostic } from "./rail.js";
import { accountConfig } from "./test-helpers.js";

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Server robustness F5 — malformed rail responses are diagnosable (spec 2026-08-26)", () => {
  it("malformed_200_response_emits_one_redacted_truncated_diagnostic_with_schema_path", async () => {
    const { config } = accountConfig();
    const leakyBody = JSON.stringify({
      message: "rate limited",
      leak: config.treasuryMnemonic,
      padding: "x".repeat(600),
    });
    const onDiagnostic = vi.fn<(event: RailDiagnostic) => void>();
    const rail = createAvmRail(config, {
      fetch: vi.fn(async () => textResponse(leakyBody)),
      onDiagnostic,
    });
    await expect(rail.getBalances(rail.treasuryAddress)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    const event = onDiagnostic.mock.calls[0]?.[0];
    expect(event?.status).toBe(200);
    expect(event?.bodyPrefix).toContain("[REDACTED]");
    expect(event?.bodyPrefix).not.toContain(config.treasuryMnemonic);
    expect(event?.bodyPrefix.length).toBeLessThanOrEqual(300);
    expect(event?.issue).toBeTruthy();
  });

  it("non_json_body_takes_the_same_single_diagnostic_path", async () => {
    const { config } = accountConfig();
    const onDiagnostic = vi.fn<(event: RailDiagnostic) => void>();
    const rail = createAvmRail(config, {
      fetch: vi.fn(async () => textResponse("<html>429 slow down</html>")),
      onDiagnostic,
    });
    await expect(rail.getBalances(rail.treasuryAddress)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    const event = onDiagnostic.mock.calls[0]?.[0];
    expect(event?.bodyPrefix).toContain("429 slow down");
    expect(event?.issue).toContain("invalid JSON");
  });
});

describe("Server robustness F2 review fix — failure provenance (spec 2026-08-26)", () => {
  it("indexer_branch_failures_carry_the_indexer_dependency_tag", async () => {
    const { config } = accountConfig();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(config.algodUrl)) {
        return new Response("{}", { status: 404 });
      }
      throw new Error("indexer down");
    });
    const rail = createAvmRail(config, { fetch: fetch as never });
    await expect(rail.getTransactionStatus("TX")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      dependency: "indexer",
    });
  });

  it("algod_fetch_failures_carry_the_algod_dependency_tag", async () => {
    const { config } = accountConfig();
    const rail = createAvmRail(config, {
      fetch: vi.fn(async () => {
        throw new Error("algod down");
      }),
    });
    await expect(rail.getBalances(rail.treasuryAddress)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      dependency: "algod",
    });
  });
});
