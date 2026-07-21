import { randomBytes } from "node:crypto";
import type { PaymentRail, Rng } from "@onestepchess/core";
import algosdk from "algosdk";
import { eq, sql } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  consumeChallenge,
  createChallenge,
  type ProofInput,
  type VerifyOutcome,
  verifyChallengeProof,
} from "../../auth/challenge.js";
import { signSession, verifySessionToken } from "../../auth/jwt.js";
import type { TurnstileVerifier } from "../../auth/turnstile.js";
import type { ServerConfig } from "../../config.js";
import type { Coordinator } from "../../coordinator/queue.js";
import type { Db } from "../../db/open.js";
import { schema } from "../../db/open.js";
import { generateName } from "../../names.js";
import { type AppEnv, AppError } from "../app.js";
import { challengeBodySchema, verifyBodySchema } from "../contracts.js";
import { clientIp } from "../middleware/client-ip.js";
import { createTokenBucket } from "../middleware/ratelimit.js";

export type AuthRouteDeps = {
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly config: () => ServerConfig;
  readonly publicBaseUrl: string;
  readonly jwtSecret: string;
  readonly trustProxyHops: number;
  readonly turnstile: TurnstileVerifier;
  readonly now: () => number;
  readonly rng: Rng;
  readonly coordinator?: Coordinator;
};

const NICKNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;
const SESSION_COOKIE = "osc_session";
const GUEST_COOKIE = "osc_guest";

function throwVerifyFailure(outcome: VerifyOutcome & { ok: false }): never {
  switch (outcome.code) {
    case "NONCE_EXPIRED":
      throw new AppError("NONCE_EXPIRED", {
        hint: "challenge expired or already used — request a new one",
      });
    case "INVALID_SIGNATURE":
      throw new AppError("INVALID_SIGNATURE", {
        hint: "signature does not verify against the challenge",
      });
    case "REKEYED_UNSUPPORTED":
      throw new AppError("REKEYED_UNSUPPORTED", {
        hint: "rekeyed accounts are not supported",
      });
    case "DEPENDENCY_UNAVAILABLE":
      throw new AppError("DEPENDENCY_UNAVAILABLE", {
        hint: "a required dependency is unavailable; retry shortly",
        retryAfterSeconds: 5,
      });
  }
}

function nicknameTaken(db: Db, nickname: string): boolean {
  return (
    db
      .select({ address: schema.players.address })
      .from(schema.players)
      .where(sql`${schema.players.nickname} = ${nickname} COLLATE NOCASE`)
      .get() !== undefined
  );
}

function freeNickname(db: Db, rng: Rng): string {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const nickname = generateName(rng);
    if (!nicknameTaken(db, nickname)) {
      return nickname;
    }
  }
  throw new Error("word list exhausted generating a nickname");
}

async function parseJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("INVALID_REQUEST", { hint: "body must be JSON" });
  }
}

function sessionTtlSeconds(config: ServerConfig): number {
  return config.JWT_TTL_HOURS * 3_600;
}

export function sessionAuth(deps: AuthRouteDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    authenticateWallet(deps, c);
    await next();
  };
}

function authenticateWallet(
  deps: AuthRouteDeps,
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): void {
  const cookieToken = getCookie(c, SESSION_COOKIE);
  const header = c.req.header("authorization");
  const bearerToken = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : undefined;
  // Browsers use the cookie, agents the bearer token; each ignores the
  // other (§6.1) — cookie wins when both are present.
  const token = cookieToken ?? bearerToken;
  if (token === undefined) {
    throw new AppError("UNAUTHENTICATED", { hint: "missing session" });
  }
  const now = deps.now();
  const claims = verifySessionToken(deps.jwtSecret, token, now);
  if (claims === null || claims.kind === "guest") {
    throw new AppError("UNAUTHENTICATED", { hint: "invalid session" });
  }
  const revoked = deps.db
    .select({ jti: schema.revokedJti.jti })
    .from(schema.revokedJti)
    .where(eq(schema.revokedJti.jti, claims.jti))
    .get();
  if (revoked !== undefined) {
    throw new AppError("UNAUTHENTICATED", { hint: "session revoked" });
  }
  const player = deps.db
    .select({
      kind: schema.players.kind,
      banned: schema.players.banned,
    })
    .from(schema.players)
    .where(eq(schema.players.address, claims.sub))
    .get();
  if (
    player === undefined ||
    player.kind === "guest" ||
    player.kind !== claims.kind
  ) {
    throw new AppError("UNAUTHENTICATED", { hint: "unknown player" });
  }
  if (player.banned) {
    throw new AppError("BANNED", { hint: "account banned" });
  }
  c.set("session", {
    address: claims.sub,
    kind: player.kind,
    jti: claims.jti,
    exp: claims.exp,
  });

  // Sliding renewal applies to the cookie only (§6.1).
  if (cookieToken !== undefined) {
    const ttlSeconds = sessionTtlSeconds(deps.config());
    const remainingMs = claims.exp * 1_000 - now;
    if (remainingMs < (ttlSeconds * 1_000) / 2) {
      const renewed = signSession(deps.jwtSecret, {
        ...claims,
        iat: Math.floor(now / 1_000),
        exp: Math.floor(now / 1_000) + ttlSeconds,
      });
      setSessionCookie(c, renewed, ttlSeconds, deps.publicBaseUrl);
    }
  }
}

function guestIdentity(
  deps: AuthRouteDeps,
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  allowLinked = false,
): string | null {
  const token = getCookie(c, GUEST_COOKIE);
  if (token === undefined) return null;
  const claims = verifySessionToken(deps.jwtSecret, token, deps.now());
  if (claims === null || claims.kind !== "guest") return null;
  const guest = deps.db
    .select({
      kind: schema.players.kind,
      banned: schema.players.banned,
      linkedAddress: schema.players.linkedAddress,
    })
    .from(schema.players)
    .where(eq(schema.players.address, claims.sub))
    .get();
  if (
    guest === undefined ||
    guest.kind !== "guest" ||
    guest.banned ||
    (!allowLinked && guest.linkedAddress !== null)
  )
    return null;
  return claims.sub;
}

export function guestOrSessionAuth(
  deps: AuthRouteDeps,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const hasWalletToken =
      getCookie(c, SESSION_COOKIE) !== undefined ||
      c.req.header("authorization")?.startsWith("Bearer ") === true;
    if (hasWalletToken) {
      authenticateWallet(deps, c);
      await next();
      return;
    }
    const guest = guestIdentity(deps, c);
    if (guest === null)
      throw new AppError("UNAUTHENTICATED", { hint: "missing session" });
    c.set("session", {
      address: guest,
      kind: "guest",
      jti: "guest",
      exp: 0,
    });
    await next();
  };
}

export function optionalGuestOrSessionAuth(
  deps: AuthRouteDeps,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const hasWalletToken =
      getCookie(c, SESSION_COOKIE) !== undefined ||
      c.req.header("authorization")?.startsWith("Bearer ") === true;
    if (hasWalletToken) {
      authenticateWallet(deps, c);
      await next();
      return;
    }
    const guest = guestIdentity(deps, c);
    if (guest !== null) {
      c.set("session", {
        address: guest,
        kind: "guest",
        jti: "guest",
        exp: 0,
      });
    }
    await next();
  };
}

function setSessionCookie(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  jwt: string,
  ttlSeconds: number,
  publicBaseUrl: string,
): void {
  setCookie(c, SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "Lax",
    // Safari rejects Secure cookies delivered by the documented HTTP
    // playtest origins. Production remains Secure because its canonical
    // PUBLIC_BASE_URL is HTTPS.
    secure: new URL(publicBaseUrl).protocol === "https:",
    path: "/",
    maxAge: ttlSeconds,
  });
}

export function setGuestCookie(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  deps: Pick<AuthRouteDeps, "jwtSecret" | "config" | "publicBaseUrl" | "now">,
  guest: string,
): void {
  const ttlSeconds = deps.config().GUEST_TOKEN_TTL_DAYS * 86_400;
  const nowSeconds = Math.floor(deps.now() / 1_000);
  const jwt = signSession(deps.jwtSecret, {
    sub: guest,
    kind: "guest",
    jti: randomBytes(16).toString("hex"),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  });
  setCookie(c, GUEST_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(deps.publicBaseUrl).protocol === "https:",
    path: "/",
    maxAge: ttlSeconds,
  });
}

export function registerAuthRoutes(
  app: Hono<AppEnv>,
  deps: AuthRouteDeps,
): void {
  const authBucket = createTokenBucket({
    limitPerMinute: () => deps.config().RATE_LIMIT_AUTH_PER_IP_MIN,
    now: deps.now,
  });

  app.use("/api/v1/auth/*", async (c, next) => {
    const decision = authBucket.take(clientIp(c, deps.trustProxyHops));
    if (!decision.ok) {
      throw new AppError("RATE_LIMITED", {
        hint: "too many auth requests from this address",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    await next();
  });

  const challengeDeps = {
    db: deps.db,
    rail: deps.rail,
    config: deps.config,
    publicBaseUrl: deps.publicBaseUrl,
    now: deps.now,
  };

  app.post("/api/v1/auth/challenge", async (c) => {
    const parsed = challengeBodySchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) {
      throw new AppError("INVALID_REQUEST", { hint: "address is required" });
    }
    return c.json(createChallenge(challengeDeps, parsed.data.address), 200);
  });

  app.post("/api/v1/auth/verify", async (c) => {
    const parsed = verifyBodySchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) {
      throw new AppError("INVALID_REQUEST", {
        hint: "body must carry address plus an arc60 or txn proof",
      });
    }
    const body = parsed.data;
    if (!algosdk.isValidAddress(body.address)) {
      throw new AppError("INVALID_ADDRESS", {
        hint: "not a valid Algorand address",
      });
    }

    const proof: ProofInput =
      body.method === "arc60"
        ? { method: "arc60", ...body.proof }
        : { method: "txn", signedTxnB64: body.signedTxnB64 };
    const outcome = await verifyChallengeProof(
      challengeDeps,
      body.address,
      proof,
    );
    if (!outcome.ok) {
      throwVerifyFailure(outcome);
    }

    const now = deps.now();
    let player = deps.db
      .select()
      .from(schema.players)
      .where(eq(schema.players.address, body.address))
      .get();

    if (player === undefined) {
      // Registration path (F2 step 3) — `kind` is immutable forever (D11);
      // recoverable failures below leave the nonce live for a re-verify.
      if (body.kind === undefined) {
        throw new AppError("REGISTRATION_REQUIRED", {
          hint: "first verify for an unknown address must carry kind",
        });
      }
      let nickname = body.nickname;
      if (body.kind === "human" && nickname === undefined) {
        throw new AppError("REGISTRATION_REQUIRED", {
          hint: "human registration requires nickname and turnstileToken",
        });
      }
      if (nickname !== undefined) {
        if (!NICKNAME_PATTERN.test(nickname)) {
          throw new AppError("INVALID_NICKNAME", {
            hint: "nickname must match ^[a-zA-Z0-9_-]{3,24}$",
          });
        }
        if (nicknameTaken(deps.db, nickname)) {
          throw new AppError("NICKNAME_TAKEN", {
            hint: "nickname already in use",
            suggestion: freeNickname(deps.db, deps.rng),
          });
        }
      }
      let turnstileVerifiedAt: number | null = null;
      if (body.kind === "human") {
        if (body.turnstileToken === undefined) {
          throw new AppError("REGISTRATION_REQUIRED", {
            hint: "human registration requires nickname and turnstileToken",
          });
        }
        const turnstile = await deps.turnstile(
          body.turnstileToken,
          clientIp(c, deps.trustProxyHops),
        );
        if (turnstile === "unavailable") {
          throw new AppError("DEPENDENCY_UNAVAILABLE", {
            hint: "captcha verification unavailable; retry shortly",
            retryAfterSeconds: 5,
          });
        }
        if (turnstile === "fail") {
          throw new AppError("TURNSTILE_FAILED", {
            hint: "captcha verification failed",
          });
        }
        turnstileVerifiedAt = now;
      }
      nickname ??= freeNickname(deps.db, deps.rng);
      deps.db
        .insert(schema.players)
        .values({
          address: body.address,
          kind: body.kind,
          nickname,
          createdAt: now,
          turnstileVerifiedAt,
        })
        .run();
      player = deps.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, body.address))
        .get();
    }
    if (player === undefined) {
      throw new Error("player row missing after registration");
    }

    let linkedGuestClaims: number | undefined;
    const guest = guestIdentity(deps, c);
    if (guest !== null && deps.coordinator !== undefined) {
      const linked = await deps.coordinator.dispatch<
        { guest: string; player: string },
        { linked: boolean; claims: number }
      >({
        type: "LinkGuest",
        payload: { guest, player: player.address },
        refIds: [guest, player.address],
      });
      if (linked.kind === "ok" && linked.result.linked) {
        linkedGuestClaims = linked.result.claims;
        deleteCookie(c, GUEST_COOKIE, { path: "/" });
      }
    }

    // Success is the only path that consumes the nonce (F2 step 4).
    consumeChallenge(deps.db, body.address);

    const ttlSeconds = sessionTtlSeconds(deps.config());
    const jwt = signSession(deps.jwtSecret, {
      sub: player.address,
      kind: player.kind,
      jti: randomBytes(16).toString("hex"),
      iat: Math.floor(now / 1_000),
      exp: Math.floor(now / 1_000) + ttlSeconds,
    });
    setSessionCookie(c, jwt, ttlSeconds, deps.publicBaseUrl);
    return c.json(
      {
        player: {
          address: player.address,
          kind: player.kind,
          nickname: player.nickname,
          createdAt: new Date(player.createdAt).toISOString(),
        },
        jwt,
        ...(linkedGuestClaims === undefined ? {} : { linkedGuestClaims }),
      },
      200,
    );
  });

  app.post("/api/v1/auth/logout", sessionAuth(deps), (c) => {
    const session = c.get("session");
    deps.db
      .insert(schema.revokedJti)
      .values({ jti: session.jti, expiresAt: session.exp * 1_000 })
      .onConflictDoNothing()
      .run();
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.get("/api/v1/auth/suggest-nickname", (c) =>
    c.json({ nickname: freeNickname(deps.db, deps.rng) }, 200),
  );
}
