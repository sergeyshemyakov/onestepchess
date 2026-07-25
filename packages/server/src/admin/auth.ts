import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifySessionToken } from "../auth/jwt.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import type { AppEnv } from "../http/app.js";

function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/.exec(header ?? "");
  return match?.[1] ?? null;
}

export type AdminAuthDeps = {
  readonly db: Db;
  readonly jwtSecret: string;
  readonly adminToken?: string;
  readonly adminAddresses: readonly string[];
  readonly now: () => number;
};

export function adminAuth(deps: AdminAuthDeps): MiddlewareHandler<AppEnv> {
  const allowlisted = new Set(deps.adminAddresses);
  return async (c, next) => {
    const headerToken = bearer(c.req.header("authorization"));
    if (
      deps.adminToken !== undefined &&
      headerToken !== null &&
      tokenMatches(headerToken, deps.adminToken)
    ) {
      c.set("adminActor", "admin-token");
      await next();
      return;
    }

    const token = getCookie(c, "osc_session") ?? headerToken;
    if (token === null || token === undefined) return c.notFound();
    const claims = verifySessionToken(deps.jwtSecret, token, deps.now());
    if (
      claims === null ||
      claims.kind === "guest" ||
      !allowlisted.has(claims.sub)
    ) {
      return c.notFound();
    }
    const revoked = deps.db
      .select({ jti: schema.revokedJti.jti })
      .from(schema.revokedJti)
      .where(eq(schema.revokedJti.jti, claims.jti))
      .get();
    const player = deps.db
      .select({ kind: schema.players.kind, banned: schema.players.banned })
      .from(schema.players)
      .where(eq(schema.players.address, claims.sub))
      .get();
    if (
      revoked !== undefined ||
      player === undefined ||
      player.kind === "guest" ||
      player.kind !== claims.kind ||
      player.banned
    ) {
      return c.notFound();
    }
    c.set("session", {
      address: claims.sub,
      kind: player.kind,
      jti: claims.jti,
      exp: claims.exp,
    });
    c.set("adminActor", claims.sub);
    await next();
  };
}
