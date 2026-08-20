import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import { createApp } from "./app.js";
import { publicApiSchemas } from "./contracts.js";
import { registerOpenApiRoute } from "./openapi.js";

const publicBaseUrl = "https://osc.example";

// The Release 2 public human endpoint inventory (server spec §6.3). OpenAPI
// path templating uses `{id}`, not Hono's `:id`.
const PUBLIC_HUMAN_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["post", "/api/v1/auth/challenge"],
  ["post", "/api/v1/auth/verify"],
  ["post", "/api/v1/auth/logout"],
  ["get", "/api/v1/auth/suggest-nickname"],
  ["get", "/api/v1/meta"],
  ["get", "/api/v1/my/profile"],
  ["patch", "/api/v1/my/profile"],
  ["post", "/api/v1/my/bonus/claim"],
  ["get", "/api/v1/my/bonus/optin-txn"],
  ["post", "/api/v1/my/bonus/optin"],
  ["get", "/api/v1/my/games"],
  ["get", "/api/v1/games/{id}/replay"],
  ["get", "/api/v1/games/{id}/card.png"],
  ["post", "/api/v1/claims"],
  ["get", "/api/v1/claims/current"],
  ["get", "/api/v1/claims/{id}/status"],
  ["post", "/api/v1/moves"],
  ["get", "/api/v1/events"],
];

function docApp() {
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl,
    mode: () => "running",
  });
  registerOpenApiRoute(app, { publicBaseUrl });
  return app;
}

describe("/api/v1/openapi.json (F12)", () => {
  it("admin_routes_are_absent_from_public_openapi_and_discovery", async () => {
    const res = await docApp().request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
    };

    expect(doc.openapi.startsWith("3.1")).toBe(true);
    expect(doc.info.title.length).toBeGreaterThan(0);
    expect(doc.info.version.length).toBeGreaterThan(0);

    for (const [method, path] of PUBLIC_HUMAN_ROUTES) {
      expect(doc.paths[path], `missing path ${path}`).toBeDefined();
      expect(
        doc.paths[path]?.[method],
        `missing ${method.toUpperCase()} ${path}`,
      ).toBeDefined();
    }

    // Admin routes and the admin-token-gated metrics endpoint are excluded from
    // the public document (server spec §6.1, §6.5).
    for (const path of Object.keys(doc.paths)) {
      expect(path.includes("/admin"), `admin route leaked: ${path}`).toBe(
        false,
      );
      expect(path.includes("/metrics"), `metrics leaked: ${path}`).toBe(false);
    }
  });

  it("declares request and response schemas for the claim route", async () => {
    const doc = (await (
      await docApp().request("/api/v1/openapi.json")
    ).json()) as {
      paths: Record<
        string,
        Record<string, { requestBody?: unknown; responses?: unknown }>
      >;
    };
    const move = doc.paths["/api/v1/moves"]?.post;
    expect(move?.requestBody).toBeDefined();
    expect(move?.responses).toBeDefined();
  });

  it("shares the live auth and claim zod contracts", () => {
    expect(
      publicApiSchemas.verifyBody.safeParse({
        address: "ADDRESS",
        kind: "agent",
        method: "txn",
        signedTxnB64: "signed",
      }).success,
    ).toBe(true);
    expect(
      publicApiSchemas.verifyBody.safeParse({
        address: "ADDRESS",
        kind: "agent",
        signature: "obsolete-shape",
      }).success,
    ).toBe(false);
    expect(
      publicApiSchemas.challengeResponse.safeParse({
        nonce: "nonce",
        expiresAt: "2026-07-20T00:00:00.000Z",
        arc60Payload: {
          data: "data",
          metadata: { scope: 1, encoding: "base64" },
        },
        fallbackTxnB64: "txn",
      }).success,
    ).toBe(true);
    expect(
      publicApiSchemas.claimResponse.safeParse({
        claim: {
          claimId: "clm_1",
          yourSide: "white",
          phase: "normal",
          demo: false,
          fen: "fen",
          legalMoves: [{ uci: "e2e4", san: "e4" }],
          stakeMicroUsdc: 1_000,
          deadline: "2026-07-20T00:00:00.000Z",
          board: "board",
        },
      }).success,
    ).toBe(true);
  });
});
