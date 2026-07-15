import { STARTING_FEN } from "@onestepchess/core";
import { Hono } from "hono";

export function createApp(): Hono {
  const app = new Hono();
  app.get("/api/v1/health", (c) => c.json({ status: "ok" }));
  app.get("/api/v1/meta", (c) => c.json({ startingFen: STARTING_FEN }));
  return app;
}
