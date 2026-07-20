import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { serverConfigSchema } from "../config.js";
import { createLogger } from "../logger.js";
import { createApp } from "./app.js";
import { jsonCompression, registerStaticRoutes } from "./static.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "osc-static-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<main>osc</main>");
  mkdirSync(join(dir, "assets"));
  const js = join(dir, "assets", "app-abcdef.js");
  writeFileSync(js, "export const raw = 1;\n");
  // Distinctive bytes so the test can prove which sibling was served.
  writeFileSync(`${js}.br`, Buffer.from("BR-COMPRESSED-APP"));
  writeFileSync(`${js}.gz`, Buffer.from("GZ-COMPRESSED-APP"));
  return dir;
}

function buildApp(
  overrides: Record<string, unknown> = {},
  publicBaseUrl = "https://osc.example",
) {
  const config = serverConfigSchema.parse(overrides);
  const dir = makeStaticDir();
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl,
    mode: () => "running",
  });
  registerStaticRoutes(app, {
    staticDir: dir,
    config: () => config,
    publicBaseUrl,
  });
  return app;
}

describe("static and discovery serving (§6.6)", () => {
  it("static_server_negotiates_precompressed_assets_and_spa_fallback", async () => {
    const app = buildApp();

    // Immutable hashed asset + brotli sibling under `Accept-Encoding: br`.
    const br = await app.request("/assets/app-abcdef.js", {
      headers: { "Accept-Encoding": "br, gzip" },
    });
    expect(br.status).toBe(200);
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("content-type")).toContain("text/javascript");
    expect(br.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(br.headers.get("vary")).toContain("Accept-Encoding");
    expect(await br.text()).toBe("BR-COMPRESSED-APP");

    // gzip sibling when only gzip is accepted.
    const gz = await app.request("/assets/app-abcdef.js", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(await gz.text()).toBe("GZ-COMPRESSED-APP");

    // Identity when nothing is accepted — no on-the-fly compression.
    const raw = await app.request("/assets/app-abcdef.js");
    expect(raw.headers.get("content-encoding")).toBeNull();
    expect(await raw.text()).toBe("export const raw = 1;\n");

    // SPA fallback: unknown non-API GET → index.html, no-cache, uncompressed.
    const spa = await app.request("/play");
    expect(await spa.text()).toBe("<main>osc</main>");
    expect(spa.headers.get("cache-control")).toBe("no-cache");
    expect(spa.headers.get("content-encoding")).toBeNull();

    // /api/* is never shadowed by the SPA fallback.
    const api = await app.request("/api/does-not-exist");
    expect(api.status).toBe(404);
    expect(await api.text()).not.toContain("<main>osc</main>");

    // Replay JSON is the one API response served compressed (jsonCompression).
    const replayApp = createApp({
      logger: createLogger({ level: "silent" }),
      publicBaseUrl: "https://osc.example",
      mode: () => "running",
    });
    replayApp.use("/api/v1/games/:id/replay", jsonCompression());
    const payload = { pgn: "x".repeat(4000) };
    replayApp.get("/api/v1/games/:id/replay", (c) => c.json(payload));
    const replay = await replayApp.request("/api/v1/games/g1/replay", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(replay.headers.get("content-encoding")).toBe("gzip");
    const decoded = gunzipSync(
      Buffer.from(await replay.arrayBuffer()),
    ).toString("utf8");
    expect(JSON.parse(decoded)).toEqual(payload);
  });

  it("security_headers_and_csp_follow_configured_origins", async () => {
    const prod = buildApp(
      {
        ALGOD_URL: "https://mainnet-api.4160.nodely.dev",
        WALLETCONNECT_RELAY_URL: "wss://relay.walletconnect.org",
      },
      "https://osc.example",
    );
    const res = await prod.request("/play");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // config-derived algod origin
    expect(csp).toContain("https://mainnet-api.4160.nodely.dev");
    // required wallet + Turnstile origins
    expect(csp).toContain("wss://relay.walletconnect.org");
    expect(csp).toContain("https://challenges.cloudflare.com");
    // no wildcard or unsafe directives
    expect(csp).not.toContain("*");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");

    // No HSTS on documented HTTP playtest origins.
    const http = buildApp({}, "http://localhost:3000");
    const dev = await http.request("/play");
    expect(dev.headers.get("strict-transport-security")).toBeNull();
  });
});
