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
