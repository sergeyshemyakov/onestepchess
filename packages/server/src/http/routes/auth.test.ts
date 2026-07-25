import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { createMockRail, type MockRail } from "@onestepchess/rail-mock";
import algosdk from "algosdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../auth/ed25519.js";
import type { TurnstileResult } from "../../auth/turnstile.js";
import { createTurnstileVerifier } from "../../auth/turnstile.js";
import { serverConfigSchema } from "../../config.js";
import { type OpenedDatabase, openDatabase, schema } from "../../db/open.js";
import { createLogger } from "../../logger.js";
import { createApp } from "../app.js";
import { registerAuthRoutes, sessionAuth } from "./auth.js";

const PUBLIC_BASE_URL = "https://osc.example";
const JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const opened: OpenedDatabase[] = [];

afterEach(() => {
  for (const database of opened.splice(0)) {
    database.sqlite.close();
  }
});

type Stack = {
  database: OpenedDatabase;
  rail: MockRail;
  app: ReturnType<typeof createApp>;
  setNow: (now: number) => void;
  turnstileCalls: { token: string }[];
  setTurnstile: (result: TurnstileResult) => void;
  publicBaseUrl: string;
};

function setup(
  configOverrides: Record<string, unknown> = {},
  publicBaseUrl = PUBLIC_BASE_URL,
): Stack {
  const database = openDatabase({ path: ":memory:" });
  opened.push(database);
  const rail = createMockRail();
  const config = serverConfigSchema.parse(configOverrides);
  let now = 1_000_000;
  let turnstileResult: TurnstileResult = "pass";
  const turnstileCalls: { token: string }[] = [];
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl,
    mode: () => "running",
  });
  const deps = {
    db: database.db,
    rail,
    config: () => config,
    publicBaseUrl,
    jwtSecret: JWT_SECRET,
    trustProxyHops: 1,
    turnstile: async (token: string) => {
      turnstileCalls.push({ token });
      return turnstileResult;
    },
    now: () => now,
    rng: Math.random,
  };
  registerAuthRoutes(app, deps);
  app.get("/api/v1/test-protected", sessionAuth(deps), (c) =>
    c.json({ address: c.get("session").address }),
  );
  return {
    database,
    rail,
    app,
    setNow: (value) => {
      now = value;
    },
    turnstileCalls,
    setTurnstile: (result) => {
      turnstileResult = result;
    },
    publicBaseUrl,
  };
}

function nobleIdentity() {
  const seed = new Uint8Array(randomBytes(32));
  return { seed, address: algosdk.encodeAddress(ed.getPublicKey(seed)) };
}

let ipCounter = 0;

function uniqueIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function postJson(
  stack: Stack,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return stack.app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": headers["x-forwarded-for"] ?? uniqueIp(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function makeProof(
  stack: Stack,
  identity: { seed: Uint8Array; address: string },
) {
  const challengeRes = await postJson(stack, "/api/v1/auth/challenge", {
    address: identity.address,
  });
  expect(challengeRes.status).toBe(200);
  const challenge = (await challengeRes.json()) as {
    nonce: string;
    arc60Payload: { data: string };
  };
  const authData = new Uint8Array([
    ...sha256(new URL(stack.publicBaseUrl).host),
    ...new Uint8Array([0x05, 0, 0, 0, 0]),
  ]);
  const message = new Uint8Array([
    ...sha256(
      new Uint8Array(Buffer.from(challenge.arc60Payload.data, "base64")),
    ),
    ...sha256(authData),
  ]);
  const signature = ed.sign(message, identity.seed);
  return {
    method: "arc60" as const,
    proof: {
      signatureB64: Buffer.from(signature).toString("base64"),
      authenticatorDataB64: Buffer.from(authData).toString("base64"),
    },
  };
}

async function registerHuman(
  stack: Stack,
  nickname: string,
): Promise<{
  identity: { seed: Uint8Array; address: string };
  jwt: string;
  cookie: string;
}> {
  const identity = nobleIdentity();
  const proof = await makeProof(stack, identity);
  const res = await postJson(stack, "/api/v1/auth/verify", {
    address: identity.address,
    kind: "human",
    nickname,
    turnstileToken: "fixture-token",
    ...proof,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { jwt: string };
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] as string;
  return { identity, jwt: body.jwt, cookie };
}

describe("challenge endpoint contract", () => {
  it("answers with the pinned challenge shape", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const res = await postJson(stack, "/api/v1/auth/challenge", {
      address: identity.address,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "arc60Payload",
      "expiresAt",
      "fallbackTxnB64",
      "nonce",
    ]);
  });

  it("rejects a malformed address with INVALID_ADDRESS", async () => {
    const stack = setup();
    const res = await postJson(stack, "/api/v1/auth/challenge", {
      address: "nope",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "INVALID_ADDRESS",
    );
  });

  it("rejects a malformed body with INVALID_REQUEST", async () => {
    const stack = setup();
    const res = await postJson(stack, "/api/v1/auth/challenge", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "INVALID_REQUEST",
    );
  });
});

describe("registration matrix (F2)", () => {
  it("first verify without kind → REGISTRATION_REQUIRED and the proof stays reusable", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);

    const first = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      ...proof,
    });
    expect(first.status).toBe(400);
    expect(((await first.json()) as { error: string }).error).toBe(
      "REGISTRATION_REQUIRED",
    );

    // Recoverable error: the same proof registers without a new challenge.
    const second = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname: "gentle-rook-042",
      turnstileToken: "fixture-token",
      ...proof,
    });
    expect(second.status).toBe(200);
  });

  it("human registration without nickname → REGISTRATION_REQUIRED; without turnstile → REGISTRATION_REQUIRED", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);

    const noNickname = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      turnstileToken: "fixture-token",
      ...proof,
    });
    expect(noNickname.status).toBe(400);
    expect(((await noNickname.json()) as { error: string }).error).toBe(
      "REGISTRATION_REQUIRED",
    );

    const noTurnstile = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname: "valid-nick",
      ...proof,
    });
    expect(noTurnstile.status).toBe(400);
    expect(((await noTurnstile.json()) as { error: string }).error).toBe(
      "REGISTRATION_REQUIRED",
    );
  });

  it("a failed turnstile check → TURNSTILE_FAILED, still recoverable", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);
    stack.setTurnstile("fail");
    const failed = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname: "valid-nick",
      turnstileToken: "bad-token",
      ...proof,
    });
    expect(failed.status).toBe(400);
    expect(((await failed.json()) as { error: string }).error).toBe(
      "TURNSTILE_FAILED",
    );

    stack.setTurnstile("pass");
    const ok = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname: "valid-nick",
      turnstileToken: "good-token",
      ...proof,
    });
    expect(ok.status).toBe(200);
  });

  it("agent_registration_is_turnstile_free_kind_immutable_and_ban_checked", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "agent",
      ...proof,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      player: { kind: string; nickname: string };
    };
    expect(body.player.kind).toBe("agent");
    expect(body.player.nickname).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);

    const reloginProof = await makeProof(stack, identity);
    const relogin = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname: "cannot-change-kind",
      turnstileToken: "not-used",
      ...reloginProof,
    });
    expect(relogin.status).toBe(200);
    expect(
      ((await relogin.json()) as { player: { kind: string } }).player.kind,
    ).toBe("agent");

    stack.database.db
      .update(schema.players)
      .set({ banned: true })
      .where(eq(schema.players.address, identity.address))
      .run();
    const bannedProof = await makeProof(stack, identity);
    const banned = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      ...bannedProof,
    });
    expect(banned.status).toBe(403);
    expect((await banned.json()) as { error: string }).toMatchObject({
      error: "BANNED",
    });
  });

  it("kind is immutable on later verifies", async () => {
    const stack = setup();
    const { identity } = await registerHuman(stack, "immutable-kind");
    const proof = await makeProof(stack, identity);
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "agent",
      ...proof,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { player: { kind: string } };
    expect(body.player.kind).toBe("human");
    expect(
      stack.database.sqlite
        .prepare("SELECT kind FROM players WHERE address = ?")
        .get(identity.address),
    ).toEqual({ kind: "human" });
  });

  it("a nonce is single-use after a successful verify", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);
    const first = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "agent",
      ...proof,
    });
    expect(first.status).toBe(200);
    const replay = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      ...proof,
    });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "NONCE_EXPIRED",
    );
  });
});

describe("nickname rules", () => {
  it.each([
    "ab",
    "a".repeat(25),
    "bad nick!",
    "ümlaut",
  ])("rejects invalid nickname %s", async (nickname) => {
    const stack = setup();
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname,
      turnstileToken: "fixture-token",
      ...proof,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "INVALID_NICKNAME",
    );
  });

  it("a taken nickname (case-insensitive) → NICKNAME_TAKEN with a suggestion", async () => {
    const stack = setup();
    await registerHuman(stack, "Taken-Nick");
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname: "taken-nick",
      turnstileToken: "fixture-token",
      ...proof,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; suggestion: string };
    expect(body.error).toBe("NICKNAME_TAKEN");
    expect(body.suggestion).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });

  it("suggest-nickname returns a word-list nickname", async () => {
    const stack = setup();
    const res = await stack.app.request("/api/v1/auth/suggest-nickname", {
      headers: { "x-forwarded-for": uniqueIp() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nickname: string };
    expect(body.nickname).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });
});

describe("sessions (JWT cookie + bearer)", () => {
  it("delivers the JWT as both cookie and body; middleware accepts each", async () => {
    const stack = setup();
    const { jwt, cookie } = await registerHuman(stack, "session-nick");
    expect(cookie.startsWith("osc_session=")).toBe(true);

    const viaCookie = await stack.app.request("/api/v1/test-protected", {
      headers: { cookie },
    });
    expect(viaCookie.status).toBe(200);

    const viaBearer = await stack.app.request("/api/v1/test-protected", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(viaBearer.status).toBe(200);

    const unauthenticated = await stack.app.request("/api/v1/test-protected");
    expect(unauthenticated.status).toBe(401);
    expect(((await unauthenticated.json()) as { error: string }).error).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("cookie session flags are httpOnly, SameSite=Lax, Secure", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "agent",
      ...proof,
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
  });

  it("Safari playtest login keeps the session cookie on a configured HTTP origin", async () => {
    const stack = setup({}, "http://localhost:3000");
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "agent",
      ...proof,
    });
    const setCookie = res.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
  });

  it("a banned player's existing session fails on the very next request", async () => {
    const stack = setup();
    const { identity, cookie } = await registerHuman(stack, "soon-banned");
    expect(
      (
        await stack.app.request("/api/v1/test-protected", {
          headers: { cookie },
        })
      ).status,
    ).toBe(200);

    stack.database.sqlite
      .prepare("UPDATE players SET banned = 1 WHERE address = ?")
      .run(identity.address);

    const res = await stack.app.request("/api/v1/test-protected", {
      headers: { cookie },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("BANNED");
  });

  it("logout revokes exactly that session's jti", async () => {
    const stack = setup();
    const first = await registerHuman(stack, "logout-one");
    // A second live session for the same player.
    const proof = await makeProof(stack, first.identity);
    const secondRes = await postJson(stack, "/api/v1/auth/verify", {
      address: first.identity.address,
      ...proof,
    });
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as { jwt: string };

    const logout = await stack.app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: {
        cookie: first.cookie,
        "x-forwarded-for": uniqueIp(),
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("osc_session=;");

    const revoked = await stack.app.request("/api/v1/test-protected", {
      headers: { cookie: first.cookie },
    });
    expect(revoked.status).toBe(401);

    const stillLive = await stack.app.request("/api/v1/test-protected", {
      headers: { authorization: `Bearer ${second.jwt}` },
    });
    expect(stillLive.status).toBe(200);
  });
});

describe("rate limits", () => {
  it("exceeding the auth bucket → 429 RATE_LIMITED with Retry-After", async () => {
    const stack = setup({ RATE_LIMIT_AUTH_PER_IP_MIN: 3 });
    const identity = nobleIdentity();
    const ip = "10.99.99.1";
    for (let index = 0; index < 3; index += 1) {
      const res = await postJson(
        stack,
        "/api/v1/auth/challenge",
        { address: identity.address },
        { "x-forwarded-for": ip },
      );
      expect(res.status).toBe(200);
    }
    const limited = await postJson(
      stack,
      "/api/v1/auth/challenge",
      { address: identity.address },
      { "x-forwarded-for": ip },
    );
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe(
      "RATE_LIMITED",
    );
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // Another IP is unaffected.
    const other = await postJson(
      stack,
      "/api/v1/auth/challenge",
      { address: identity.address },
      { "x-forwarded-for": "10.99.99.2" },
    );
    expect(other.status).toBe(200);
  });
});

describe("turnstile verifier (fixture-injected fetch, zero network)", () => {
  it("proves the pass and fail paths through the injected fetch", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        const token = new URLSearchParams(String(init?.body)).get("response");
        return new Response(JSON.stringify({ success: token === "good" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const verifier = createTurnstileVerifier({
      secret: "secret-1",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await verifier("good", "1.2.3.4")).toBe("pass");
    expect(await verifier("bad", null)).toBe("fail");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("challenges.cloudflare.com");
    expect(calls[0]?.body).toContain("secret=secret-1");
    expect(calls[0]?.body).toContain("remoteip=1.2.3.4");
  });

  it("maps a transport outage to unavailable", async () => {
    const verifier = createTurnstileVerifier({
      secret: "secret-1",
      fetchFn: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(await verifier("token", null)).toBe("unavailable");
  });

  it("a turnstile outage on verify → DEPENDENCY_UNAVAILABLE, nonce reusable", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    const proof = await makeProof(stack, identity);
    stack.setTurnstile("unavailable");
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname: "later-human",
      turnstileToken: "token",
      ...proof,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(
      "DEPENDENCY_UNAVAILABLE",
    );

    stack.setTurnstile("pass");
    const retry = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "human",
      nickname: "later-human",
      turnstileToken: "token",
      ...proof,
    });
    expect(retry.status).toBe(200);
  });
});

describe("verify error mapping", () => {
  it("maps a bad signature to INVALID_SIGNATURE", async () => {
    const stack = setup();
    const identity = nobleIdentity();
    await makeProof(stack, identity);
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: identity.address,
      kind: "agent",
      method: "arc60",
      proof: {
        signatureB64: Buffer.from(new Uint8Array(64)).toString("base64"),
        authenticatorDataB64: Buffer.from(new Uint8Array(37)).toString(
          "base64",
        ),
      },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "INVALID_SIGNATURE",
    );
  });

  it("maps an unknown-body shape to INVALID_REQUEST", async () => {
    const stack = setup();
    const res = await postJson(stack, "/api/v1/auth/verify", {
      address: "x",
      method: "carrier-pigeon",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "INVALID_REQUEST",
    );
  });
});
