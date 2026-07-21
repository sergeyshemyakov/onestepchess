import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { serverConfigSchema } from "../config.js";
import { type OpenedDatabase, openDatabase } from "../db/open.js";
import { createLogger } from "../logger.js";
import { createApp } from "./app.js";
import { jsonCompression, registerStaticRoutes } from "./static.js";

const dirs: string[] = [];
const opened: OpenedDatabase[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  for (const database of opened.splice(0)) database.sqlite.close();
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

    // Quality values are authoritative: an explicitly rejected encoding is
    // never selected, and the highest acceptable quality wins.
    const quality = await app.request("/assets/app-abcdef.js", {
      headers: {
        "Accept-Encoding": "br;q=0, gzip;q=0.8, identity;q=0.1",
      },
    });
    expect(quality.headers.get("content-encoding")).toBe("gzip");
    const identityOnly = await app.request("/assets/app-abcdef.js", {
      headers: { "Accept-Encoding": "br;q=0, gzip;q=0" },
    });
    expect(identityOnly.headers.get("content-encoding")).toBeNull();
    expect(identityOnly.headers.get("vary")).toContain("Accept-Encoding");
    const unacceptable = await app.request("/assets/app-abcdef.js", {
      headers: {
        "Accept-Encoding": "br;q=0, gzip;q=0, identity;q=0",
      },
    });
    expect(unacceptable.status).toBe(406);

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

    const replayQuality = await replayApp.request("/api/v1/games/g1/replay", {
      headers: { "Accept-Encoding": "br;q=0, gzip;q=1" },
    });
    expect(replayQuality.headers.get("content-encoding")).toBe("gzip");
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

  it("replay_og_unfurl_preserves_nonterminal_existence_blindness", async () => {
    const shell =
      '<!doctype html><html><head><meta name="description" content="pitch"><!-- osc:og --><title>One Step Chess</title></head><body></body></html>';
    const dir = mkdtempSync(join(tmpdir(), "osc-og-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.html"), shell);
    const database = openDatabase({ path: ":memory:" });
    opened.push(database);
    database.sqlite.exec(`
      INSERT INTO games(id,name,status,fen,rules_json,ply,last_ply_at,created_at,result,termination,replay_json,finished_at) VALUES
        ('gm_term','Knightmare & <fun>','finished','fen','{}',2,0,0,'white','checkmate','{"plies":[],"pgn":""}',5),
        ('gm_active','live-game','active','fen','{}',0,0,0,NULL,NULL,NULL,NULL);
    `);
    const publicBaseUrl = "https://osc.example";
    const app = createApp({
      logger: createLogger({ level: "silent" }),
      publicBaseUrl,
      mode: () => "running",
    });
    registerStaticRoutes(app, {
      staticDir: dir,
      config: () => serverConfigSchema.parse({}),
      publicBaseUrl,
      db: database.db,
    });

    // A normal SPA route serves the untouched shell (placeholder intact).
    const rawShell = await (await app.request("/play")).text();
    expect(rawShell).toBe(shell);

    // A terminal replay injects escaped OG/Twitter tags.
    const term = await (await app.request("/replay/gm_term")).text();
    expect(term).not.toBe(shell);
    expect(term).not.toContain("<!-- osc:og -->");
    expect(term).toContain(
      '<meta property="og:title" content="Knightmare &amp; &lt;fun&gt;">',
    );
    expect(term).toContain(
      `<meta property="og:image" content="${publicBaseUrl}/api/v1/games/gm_term/card.png">`,
    );
    expect(term).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    // The raw name never appears unescaped.
    expect(term).not.toContain("Knightmare & <fun>");

    // ?ply forwards into the card image URL.
    const termPly = await (await app.request("/replay/gm_term?ply=2")).text();
    expect(termPly).toContain(
      `${publicBaseUrl}/api/v1/games/gm_term/card.png?ply=2`,
    );

    // Unknown and non-terminal ids serve the byte-identical untouched shell —
    // no existence signal (I7).
    for (const id of ["gm_missing", "gm_active"]) {
      const res = await (await app.request(`/replay/${id}`)).text();
      expect(res).toBe(rawShell);
    }
  });
});
