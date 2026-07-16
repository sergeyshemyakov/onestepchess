import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRail } from "@onestepchess/rail-mock";
import { afterEach, describe, expect, it } from "vitest";
import { serverConfigSchema } from "../../config.js";
import { CoordinatorViews } from "../../coordinator/views.js";
import { openDatabase } from "../../db/open.js";
import { createLogger } from "../../logger.js";
import { createApp } from "../app.js";
import { registerDiscoveryRoutes } from "./discovery.js";

const directories: string[] = [];

function setup() {
  const opened = openDatabase({ path: ":memory:" });
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl: "https://osc.example",
    mode: () => "running",
  });
  const dir = mkdtempSync(join(tmpdir(), "osc-static-"));
  directories.push(dir);
  writeFileSync(join(dir, "index.html"), "<main>osc</main>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-abcdef.js"), "export {};");
  registerDiscoveryRoutes(app, {
    db: opened.db,
    config: () => serverConfigSchema.parse({}),
    jwtSecret: "x".repeat(32),
    now: Date.now,
    views: new CoordinatorViews(),
    mode: () => "running",
    rail: createMockRail(),
    publicBaseUrl: "https://osc.example",
    staticDir: dir,
  });
  return { app, opened };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("discovery and static serving (F12)", () => {
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

  it("falls back to index without shadowing API routes and gives assets immutable caching", async () => {
    const { app, opened } = setup();
    const fallback = await app.request("/play");
    const asset = await app.request("/assets/app-abcdef.js");
    const api = await app.request("/api/unknown");
    expect(await fallback.text()).toBe("<main>osc</main>");
    expect(fallback.headers.get("cache-control")).toBe("no-cache");
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(api.status).toBe(404);
    opened.sqlite.close();
  });
});
