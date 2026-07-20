import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Hono } from "hono";
import type { AppEnv } from "./app.js";

/** OpenAPI 3.1 for the public human API, generated from zod route declarations
 * (server spec §6.1). Admin routes (§6.5) and the admin-token-gated
 * `/api/v1/metrics` endpoint are deliberately absent — this document is the
 * public agent/browser contract only. Routes are declared here rather than on
 * the live Hono handlers because the Release-1 handlers predate
 * `@hono/zod-openapi`; the inventory below is asserted complete by the F12
 * contract test. */

const errorEnvelope = z
  .object({
    error: z.string(),
    hint: z.string(),
    docs: z.string().url(),
  })
  .meta({ id: "ErrorEnvelope" });

const claimView = z
  .object({
    claimId: z.string(),
    fen: z.string(),
    legalMoves: z.array(z.string()),
    deadline: z.string(),
    demo: z.boolean(),
    stakeMicroUsdc: z.number().int(),
    ascii: z.string().optional(),
  })
  .meta({ id: "ClaimView" });

const idParam = z.object({
  id: z.string().meta({ param: { name: "id", in: "path" } }),
});

function json<T extends z.ZodType>(description: string, schema: T) {
  return { description, content: { "application/json": { schema } } };
}

type RouteMethod = "get" | "post" | "patch" | "delete" | "put";

type RouteDecl = Parameters<
  OpenAPIHono["openAPIRegistry"]["registerPath"]
>[0] & { method: RouteMethod };

const ROUTES: readonly RouteDecl[] = [
  {
    method: "post",
    path: "/api/v1/auth/challenge",
    tags: ["auth"],
    summary: "Request a wallet-signature challenge",
    request: {
      body: {
        content: {
          "application/json": { schema: z.object({ address: z.string() }) },
        },
      },
    },
    responses: {
      200: json(
        "Challenge nonce to sign",
        z.object({ challenge: z.string(), expiresAt: z.string() }),
      ),
      400: json("Invalid address", errorEnvelope),
    },
  },
  {
    method: "post",
    path: "/api/v1/auth/verify",
    tags: ["auth"],
    summary: "Verify a signed challenge and open a session",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              address: z.string(),
              kind: z.enum(["human", "agent"]).optional(),
              nickname: z.string().optional(),
              signature: z.string(),
              turnstileToken: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        "Session token",
        z.object({
          jwt: z.string(),
          address: z.string(),
          kind: z.enum(["human", "agent"]),
        }),
      ),
      401: json("Signature did not verify", errorEnvelope),
    },
  },
  {
    method: "post",
    path: "/api/v1/auth/logout",
    tags: ["auth"],
    summary: "Revoke the current session",
    responses: { 204: { description: "Logged out" } },
  },
  {
    method: "get",
    path: "/api/v1/auth/suggest-nickname",
    tags: ["auth"],
    summary: "Suggest an available nickname",
    responses: {
      200: json("A free nickname", z.object({ suggestion: z.string() })),
    },
  },
  {
    method: "get",
    path: "/api/v1/meta",
    tags: ["discovery"],
    summary: "Network, economics, timing, quotas, and status",
    responses: {
      200: json(
        "Server metadata",
        z.object({
          name: z.string(),
          network: z.object({}).loose(),
          economics: z.object({}).loose(),
          timing: z.object({}).loose(),
          quotas: z.object({}).loose(),
          status: z.object({ mode: z.enum(["running", "paused"]) }).loose(),
          rules: z.string(),
        }),
      ),
    },
  },
  {
    method: "get",
    path: "/api/v1/my/profile",
    tags: ["human"],
    summary: "The authenticated player's profile",
    responses: {
      200: json(
        "Profile",
        z.object({
          address: z.string(),
          kind: z.enum(["human", "agent"]),
          nickname: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
      401: json("Not authenticated", errorEnvelope),
    },
  },
  {
    method: "patch",
    path: "/api/v1/my/profile",
    tags: ["human"],
    summary: "Rename the authenticated player",
    request: {
      body: {
        content: {
          "application/json": { schema: z.object({ nickname: z.string() }) },
        },
      },
    },
    responses: {
      200: json("Updated profile", z.object({ nickname: z.string() })),
      409: json("Nickname taken", errorEnvelope),
    },
  },
  {
    method: "get",
    path: "/api/v1/my/games",
    tags: ["human"],
    summary: "The player's game history (paginated)",
    request: { query: z.object({ page: z.coerce.number().int().optional() }) },
    responses: {
      200: json(
        "Games page",
        z.object({
          items: z.array(z.object({}).loose()),
          page: z.number().int(),
          pageCount: z.number().int(),
          total: z.number().int(),
        }),
      ),
    },
  },
  {
    method: "get",
    path: "/api/v1/games/{id}/replay",
    tags: ["human"],
    summary: "Full replay of a terminal game",
    request: { params: idParam },
    responses: {
      200: json("Replay document", z.object({}).loose()),
      404: json("Game not found or not terminal", errorEnvelope),
    },
  },
  {
    method: "post",
    path: "/api/v1/claims",
    tags: ["claims"],
    summary: "Claim a position (staked or demo)",
    request: {
      query: z.object({ include: z.enum(["ascii"]).optional() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              demo: z.boolean().optional(),
              turnstileToken: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json("A claimable position", claimView),
      204: { description: "Nothing eligible; retry after Retry-After" },
      429: json("Quota or rate limit", errorEnvelope),
    },
  },
  {
    method: "get",
    path: "/api/v1/claims/current",
    tags: ["claims"],
    summary: "The player's current open claim",
    responses: {
      200: json("Open claim", claimView),
      404: json("No open claim", errorEnvelope),
    },
  },
  {
    method: "get",
    path: "/api/v1/claims/{id}/status",
    tags: ["claims"],
    summary: "Status of a claim",
    request: { params: idParam },
    responses: {
      200: json("Claim status", z.object({}).loose()),
      404: json("Claim not found", errorEnvelope),
    },
  },
  {
    method: "post",
    path: "/api/v1/claims/{id}/move",
    tags: ["claims"],
    summary: "Submit the one move for a claim",
    request: {
      params: idParam,
      body: {
        content: {
          "application/json": { schema: z.object({ move: z.string() }) },
        },
      },
    },
    responses: {
      200: json("Move receipt", z.object({}).loose()),
      402: json("x402 payment required", errorEnvelope),
      400: json("Illegal or ambiguous move", errorEnvelope),
    },
  },
  {
    method: "get",
    path: "/api/v1/events",
    tags: ["events"],
    summary: "Server-sent events stream (resume with Last-Event-ID)",
    request: {
      query: z.object({ lastEventId: z.coerce.number().int().optional() }),
    },
    responses: {
      200: {
        description: "text/event-stream of live events",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  },
];

export function buildOpenApiDocument(opts: {
  readonly publicBaseUrl: string;
}): unknown {
  const registry = new OpenAPIHono();
  registry.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  registry.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "osc_session",
  });
  for (const route of ROUTES) {
    registry.openAPIRegistry.registerPath(route);
  }
  return registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "One Step Chess API",
      version: "1.0.0",
      description:
        "Public human and agent API. Admin routes are excluded by design.",
    },
    servers: [{ url: opts.publicBaseUrl }],
  });
}

export function registerOpenApiRoute(
  app: Hono<AppEnv>,
  opts: { readonly publicBaseUrl: string },
): void {
  const document = buildOpenApiDocument(opts);
  app.get("/api/v1/openapi.json", (c) => c.json(document));
}
