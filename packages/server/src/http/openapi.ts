import { OpenAPIHono } from "@hono/zod-openapi";
import type { Hono } from "hono";
import type { AppEnv } from "./app.js";
import { publicApiRoutes } from "./contracts.js";

/** OpenAPI 3.1 generated from the shared Zod route contracts used by the live
 * handlers. Admin routes (§6.5) and admin-token metrics stay private. */
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
  for (const route of publicApiRoutes) {
    registry.openAPIRegistry.registerPath(route);
  }
  return registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "One Step Chess API",
      version: "1.0.0",
      description:
        "Public human and agent API. Admin and operational routes are excluded.",
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
