import { createHash } from "node:crypto";
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

// Mirrors the web shell's theme-bootstrap inline script: the served CSP must
// allow exactly this content by hash, never via 'unsafe-inline'.
const INLINE_BOOT_SCRIPT = 'window.__oscTheme = "green";';

function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "osc-static-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "index.html"),
    `<script>${INLINE_BOOT_SCRIPT}</script><main>osc</main>`,
  );
  mkdirSync(join(dir, "assets"));
  const js = join(dir, "assets", "app-abcdef.js");
  writeFileSync(js, "export const raw = 1;\n");
  // Distinctive bytes so the test can prove which sibling was served.
  writeFileSync(`${js}.br`, Buffer.from("BR-COMPRESSED-APP"));
  writeFileSync(`${js}.gz`, Buffer.from("GZ-COMPRESSED-APP"));
  writeFileSync(join(dir, "favicon.ico"), Buffer.from("ICO"));
  writeFileSync(join(dir, "apple-touch-icon.png"), Buffer.from("PNG"));
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
  it("static_server_types_site_icons_as_images", async () => {
    const app = buildApp();

    // Bazaar/dashboard crawlers reject an icon served as octet-stream, so the
    // shell's declared icons must carry their real image type.
    const ico = await app.request("/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");

    const png = await app.request("/apple-touch-icon.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
  });

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
    expect(await spa.text()).toBe(
      `<script>${INLINE_BOOT_SCRIPT}</script><main>osc</main>`,
    );
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
    expect(csp).toContain("https://wc.perawallet.app");
    expect(csp).toContain("https://static.defly.app");
    expect(csp).toContain("wss://wallet-connect-a.perawallet.app");
    expect(csp).toContain("wss://wallet-connect-h.perawallet.app");
    expect(csp).toContain("https://challenges.cloudflare.com");
    // WalletConnect v1 dials a random [a-z0-9] bridge shard subdomain.
    expect(csp).toContain("https://*.bridge.walletconnect.org");
    expect(csp).toContain("wss://*.bridge.walletconnect.org");
    // Pera modal assets, path-scoped to Pera's own bucket — never all of S3.
    // `data:` is inert in connect-src (the URL is the content; nothing leaves
    // the page) and lets Pera fetch its QR-center logo SVG.
    expect(csp).toContain(
      "connect-src 'self' data: https://mainnet-api.4160.nodely.dev",
    );
    expect(csp).toContain("https://s3.amazonaws.com/wc.perawallet.app/");
    expect(csp).toContain(
      "media-src 'self' https://s3.amazonaws.com/wc.perawallet.app/",
    );
    expect(csp).not.toContain("s3.amazonaws.com;");
    expect(csp).not.toContain("s3.amazonaws.com ");
    // Pera Connect renders its QR modal from JS-injected <style> elements, so
    // style-src alone carries 'unsafe-inline'; the Google Fonts stylesheet its
    // modal @imports is allowed by exact origin, with its font files in
    // font-src.
    expect(csp).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    // script-src stays strict: the shell's own inline bootstrap is allowed by
    // its exact hash (recomputed from the served index.html), never by
    // 'unsafe-inline'.
    const bootHash = createHash("sha256")
      .update(INLINE_BOOT_SCRIPT)
      .digest("base64");
    const scriptSrc = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src"));
    expect(scriptSrc).toBe(
      `script-src 'self' https://challenges.cloudflare.com 'sha256-${bootHash}'`,
    );
    // No bare-wildcard source: every `*` is a subdomain wildcard on a
    // reviewed host (the WalletConnect bridge shards).
    const sources = csp
      .split(";")
      .flatMap((directive) => directive.trim().split(/\s+/).slice(1));
    expect(sources).not.toContain("*");
    for (const source of sources.filter((entry) => entry.includes("*"))) {
      expect(source).toMatch(
        /^(https|wss):\/\/\*\.bridge\.walletconnect\.org$/,
      );
    }
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
    expect(term).toContain('<meta property="og:title" content="Game term">');
    expect(term).toContain(
      `<meta property="og:image" content="${publicBaseUrl}/api/v1/games/gm_term/card.png">`,
    );
    expect(term).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    // The retired word-list name never appears in the public metadata.
    expect(term).not.toContain("Knightmare & <fun>");
    expect(term).not.toContain("Knightmare &amp; &lt;fun&gt;");

    // The last owned ply forwards into the single-position card image URL.
    const termPly = await (
      await app.request("/replay/gm_term?plies=1,2")
    ).text();
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
