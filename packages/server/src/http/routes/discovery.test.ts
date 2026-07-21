import { createMockRail } from "@onestepchess/rail-mock";
import { describe, expect, it } from "vitest";
import { signSession } from "../../auth/jwt.js";
import { serverConfigSchema } from "../../config.js";
import { CoordinatorViews } from "../../coordinator/views.js";
import { openDatabase, schema } from "../../db/open.js";
import { createLogger } from "../../logger.js";
import { createApp } from "../app.js";
import { registerDiscoveryRoutes } from "./discovery.js";

function setup() {
  const opened = openDatabase({ path: ":memory:" });
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl: "https://osc.example",
    mode: () => "running",
  });
  registerDiscoveryRoutes(app, {
    db: opened.db,
    config: () => serverConfigSchema.parse({}),
    jwtSecret: "x".repeat(32),
    now: Date.now,
    views: new CoordinatorViews(),
    mode: () => "running",
    rail: createMockRail(),
    publicBaseUrl: "https://osc.example",
  });
  return { app, opened };
}

describe("discovery meta and profile (F12)", () => {
  it("serves the complete release-one meta contract without stats", async () => {
    const { app, opened } = setup();
    const response = await app.request("/api/v1/meta");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      name: "One Step Chess",
      network: { caip2: "mock:local", algodUrl: "http://localhost:4001" },
      status: { mode: "running", banner: null },
      pool: { active: 0, endspiel: 0 },
    });
    expect(body).not.toHaveProperty("stats");
    opened.sqlite.close();
  });

  it("serves meta without changing the database", async () => {
    const { app, opened } = setup();
    const before = opened.sqlite
      .prepare("SELECT total_changes() AS n")
      .get() as { n: number };

    await app.request("/api/v1/meta");

    const after = opened.sqlite
      .prepare("SELECT total_changes() AS n")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
    opened.sqlite.close();
  });

  it("returns the minimal profile for bearer and cookie sessions", async () => {
    const { app, opened } = setup();
    const now = Date.now();
    opened.db
      .insert(schema.players)
      .values({
        address: "alice",
        kind: "human",
        nickname: "Alice",
        createdAt: now,
      })
      .run();
    const jwt = signSession("x".repeat(32), {
      sub: "alice",
      kind: "human",
      jti: "profile",
      iat: Math.floor(now / 1_000),
      exp: Math.floor(now / 1_000) + 3_600,
    });

    const bearer = await app.request("/api/v1/my/profile", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const cookie = await app.request("/api/v1/my/profile", {
      headers: { Cookie: `osc_session=${jwt}` },
    });

    const expected = {
      address: "alice",
      kind: "human",
      nickname: "Alice",
      createdAt: new Date(now).toISOString(),
    };
    expect(await bearer.json()).toEqual(expected);
    expect(await cookie.json()).toEqual(expected);
    opened.sqlite.close();
  });
});
