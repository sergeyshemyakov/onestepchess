import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { Hono, MiddlewareHandler } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { ServerConfig } from "../config.js";
import type { AppEnv } from "./app.js";

/** Cloudflare Turnstile's fixed script/frame/connect origin (server spec
 * §6.6). Unlike the algod and WalletConnect origins it is not configurable. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export type StaticDeps = {
  readonly staticDir?: string;
  readonly config: () => ServerConfig;
  readonly publicBaseUrl: string;
};

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** CSP + hardening headers for HTML/static responses (server spec §6.6). The
 * algod and WalletConnect origins are config-derived; there is no `*`,
 * `unsafe-inline`, or `unsafe-eval`. HSTS rides only on HTTPS origins. */
export function securityHeaders(deps: {
  readonly config: ServerConfig;
  readonly publicBaseUrl: string;
}): Record<string, string> {
  const algod = safeOrigin(deps.config.ALGOD_URL);
  const walletconnect = safeOrigin(deps.config.WALLETCONNECT_RELAY_URL);
  const connect = ["'self'", algod, walletconnect, TURNSTILE_ORIGIN]
    .filter((origin): origin is string => origin !== null)
    .join(" ");
  const csp = [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    `script-src 'self' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    `connect-src ${connect}`,
    "img-src 'self' data: blob:",
    "style-src 'self'",
    "font-src 'self'",
  ].join("; ");
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": csp,
  };
  if (deps.publicBaseUrl.startsWith("https://")) {
    headers["Strict-Transport-Security"] =
      "max-age=63072000; includeSubDomains";
  }
  return headers;
}

type Encoding = "br" | "gzip" | "identity";

function encodingQuality(header: string, encoding: Encoding): number {
  if (header.trim() === "") return encoding === "identity" ? 1 : 0;
  let exact: number | undefined;
  let wildcard: number | undefined;
  for (const item of header.toLowerCase().split(",")) {
    const [rawName, ...params] = item.trim().split(";");
    const name = rawName?.trim();
    if (name === undefined || name === "") continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/.exec(param);
      if (match !== null) quality = Number(match[1]);
      else if (/^\s*q\s*=/.test(param)) quality = 0;
    }
    if (name === encoding) exact = quality;
    else if (name === "*") wildcard = quality;
  }
  if (exact !== undefined) return exact;
  if (encoding === "identity") return wildcard === 0 ? 0 : 1;
  return wildcard ?? 0;
}

function negotiateEncoding(
  acceptEncoding: string,
  available: ReadonlySet<Encoding>,
): Encoding | null {
  const preference: Record<Encoding, number> = { br: 3, gzip: 2, identity: 1 };
  return (
    (["br", "gzip", "identity"] as const)
      .filter((encoding) => available.has(encoding))
      .map((encoding) => ({
        encoding,
        quality: encodingQuality(acceptEncoding, encoding),
      }))
      .filter(({ quality }) => quality > 0)
      .sort(
        (a, b) =>
          b.quality - a.quality ||
          preference[b.encoding] - preference[a.encoding],
      )[0]?.encoding ?? null
  );
}

/** Picks the best acceptable on-disk representation. Quality values and
 * explicit `q=0` exclusions are honored; no bytes are compressed here. */
function precompressed(
  candidate: string,
  acceptEncoding: string,
):
  | { readonly path: string; readonly encoding: "br" | "gzip" }
  | Encoding
  | null {
  const available = new Set<Encoding>(["identity"]);
  if (existsSync(`${candidate}.br`)) available.add("br");
  if (existsSync(`${candidate}.gz`)) available.add("gzip");
  const encoding = negotiateEncoding(acceptEncoding, available);
  if (encoding === "br") return { path: `${candidate}.br`, encoding };
  if (encoding === "gzip") return { path: `${candidate}.gz`, encoding };
  return encoding;
}

/** SPA static serving with precompressed negotiation, hashed-asset immutable
 * caching, no-cache `index.html`, and security headers (server spec §6.6).
 * Registered last so it never shadows `/api/*`, `/healthz`, or `/llms.txt`. */
export function registerStaticRoutes(
  app: Hono<AppEnv>,
  deps: StaticDeps,
): void {
  app.get("*", (c) => {
    if (
      deps.staticDir === undefined ||
      c.req.path.startsWith("/api/") ||
      c.req.path === "/healthz" ||
      c.req.path === "/llms.txt"
    )
      return c.notFound();
    const headers = securityHeaders({
      config: deps.config(),
      publicBaseUrl: deps.publicBaseUrl,
    });
    const root = resolve(deps.staticDir);
    const relative = normalize(c.req.path.replace(/^\//, ""));
    const candidate = resolve(root, relative);
    if (
      candidate.startsWith(root) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const immutable =
        relative.startsWith("assets/") && /-[A-Za-z0-9_-]{6,}\./.test(relative);
      const cacheControl = immutable ? IMMUTABLE_CACHE : "no-cache";
      const negotiated = precompressed(
        candidate,
        c.req.header("accept-encoding") ?? "",
      );
      const vary: Record<string, string> = {};
      if (existsSync(`${candidate}.br`) || existsSync(`${candidate}.gz`)) {
        vary.Vary = "Accept-Encoding";
      }
      if (negotiated === null) {
        return c.body(null, 406, { ...headers, ...vary });
      }
      if (typeof negotiated !== "string") {
        return c.body(readFileSync(negotiated.path), 200, {
          ...headers,
          ...vary,
          "Content-Type": contentType(candidate),
          "Cache-Control": cacheControl,
          "Content-Encoding": negotiated.encoding,
        });
      }
      return c.body(readFileSync(candidate), 200, {
        ...headers,
        ...vary,
        "Content-Type": contentType(candidate),
        "Cache-Control": cacheControl,
      });
    }
    const index = join(root, "index.html");
    if (!existsSync(index)) return c.notFound();
    return c.body(readFileSync(index, "utf8"), 200, {
      ...headers,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  });
}

function toHeaderRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/** On-the-fly compression for the replay JSON response — the single API
 * response the spec compresses (server spec §6.6). Scoped by route in
 * `index.ts`; other JSON responses are never compressed here. */
export function jsonCompression(
  options: { readonly minBytes?: number } = {},
): MiddlewareHandler {
  const minBytes = options.minBytes ?? 1024;
  return async (c, next) => {
    await next();
    const res = c.res;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return;
    if (res.headers.get("content-encoding") !== null) return;
    const encoding = negotiateEncoding(
      c.req.header("accept-encoding") ?? "",
      new Set<Encoding>(["br", "gzip", "identity"]),
    );
    if (encoding === null) {
      c.res = c.newResponse(null, 406);
      return;
    }
    if (encoding === "identity") return;
    const status = res.status as StatusCode;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < minBytes) {
      // Body already consumed by arrayBuffer(); rebuild an identical response.
      c.res = c.newResponse(body, status, toHeaderRecord(res.headers));
      return;
    }
    const compressed =
      encoding === "br" ? brotliCompressSync(body) : gzipSync(body);
    const headers = toHeaderRecord(res.headers);
    headers["content-encoding"] = encoding;
    delete headers["content-length"];
    headers.vary = headers.vary
      ? `${headers.vary}, Accept-Encoding`
      : "Accept-Encoding";
    c.res = c.newResponse(compressed, status, headers);
  };
}
