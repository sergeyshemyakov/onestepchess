import { RailError } from "@onestepchess/core";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import { AppError, createApp } from "./app.js";

const publicBaseUrl = "https://osc.example";

function testApp(mode: () => "running" | "paused" = () => "running") {
  return createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl,
    mode,
  });
}

describe("healthz", () => {
  it("answers the /healthz contract", async () => {
    const res = await testApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", mode: "running" });
  });

  it("reflects paused mode", async () => {
    const res = await testApp(() => "paused").request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", mode: "paused" });
  });
});

describe("error envelope", () => {
  it("renders AppError as the pinned envelope with the docs anchor", async () => {
    const app = testApp();
    app.get("/api/v1/test-error", () => {
      throw new AppError("QUOTA_OUT", { hint: "quota exhausted" });
    });
    const res = await app.request("/api/v1/test-error");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "QUOTA_OUT",
      hint: "quota exhausted",
      docs: `${publicBaseUrl}/llms.txt#err-quota_out`,
    });
  });

  it("carries only typed additions", async () => {
    const app = testApp();
    app.get("/api/v1/test-nickname", () => {
      throw new AppError("NICKNAME_TAKEN", {
        hint: "taken",
        suggestion: "gentle-rook-042",
      });
    });
    const res = await app.request("/api/v1/test-nickname");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "NICKNAME_TAKEN",
      hint: "taken",
      docs: `${publicBaseUrl}/llms.txt#err-nickname_taken`,
      suggestion: "gentle-rook-042",
    });
  });

  it("maps unexpected errors to INTERNAL with a requestId", async () => {
    const app = testApp();
    app.get("/api/v1/test-boom", () => {
      throw new Error("boom");
    });
    const res = await app.request("/api/v1/test-boom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("INTERNAL");
    expect(body.docs).toBe(`${publicBaseUrl}/llms.txt#err-internal`);
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });

  it("renders unknown routes as a 404 envelope", async () => {
    const res = await testApp().request("/api/v1/nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(body.docs).toBe(`${publicBaseUrl}/llms.txt#err-not_found`);
  });
});

describe("Server robustness F2 — rail unavailability maps to 503 (spec 2026-08-26)", () => {
  it("rail_unavailable_error_returns_503_with_retry_after_not_500", async () => {
    const app = testApp();
    app.get("/boom", () => {
      throw new RailError("UNAVAILABLE", "Rail dependency circuit open");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(await res.json()).toMatchObject({
      error: "DEPENDENCY_UNAVAILABLE",
    });
  });

  it("rail_contract_error_still_reports_internal", async () => {
    const app = testApp();
    app.get("/bug", () => {
      throw new RailError("CONTRACT", "Invalid payout instruction");
    });
    const res = await app.request("/bug");
    expect(res.status).toBe(500);
  });
});

describe("Server robustness F3 — warming guard while the boot gate is active (spec 2026-08-26)", () => {
  function warmingApp(bootActive: () => boolean) {
    return createApp({
      logger: createLogger({ level: "silent" }),
      publicBaseUrl,
      mode: () => "paused",
      bootActive,
    });
  }

  it("warming_guard_allows_reads_rejects_writes_and_exempts_admin_controls", async () => {
    let active = true;
    const app = warmingApp(() => active);
    app.post("/api/v1/claims", (c) => c.json({ ok: true }));
    app.post("/api/v1/my/bonus/claim", (c) => c.json({ ok: true }));
    app.post("/api/v1/admin/config", (c) => c.json({ ok: true }));

    expect((await app.request("/healthz")).status).toBe(200);
    const claim = await app.request("/api/v1/claims", { method: "POST" });
    expect(claim.status).toBe(503);
    expect(claim.headers.get("Retry-After")).toBeTruthy();
    expect(await claim.json()).toMatchObject({ error: "PAUSED" });
    const bonus = await app.request("/api/v1/my/bonus/claim", {
      method: "POST",
    });
    expect(bonus.status).toBe(503);
    const adminConfig = await app.request("/api/v1/admin/config", {
      method: "POST",
    });
    expect(adminConfig.status).toBe(200);

    active = false;
    const afterWarmup = await app.request("/api/v1/claims", {
      method: "POST",
    });
    expect(afterWarmup.status).toBe(200);
  });
});
