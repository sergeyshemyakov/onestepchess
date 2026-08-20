import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { createRng } from "@onestepchess/core";
import { createMockRail } from "@onestepchess/rail-mock";
import algosdk from "algosdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../auth/ed25519.js";
import { signSession } from "../../auth/jwt.js";
import type { TurnstileResult } from "../../auth/turnstile.js";
import { serverConfigSchema } from "../../config.js";
import { ChessAdapterRegistry } from "../../coordinator/chess-registry.js";
import {
  type ClaimRecord,
  registerClaimCommands,
} from "../../coordinator/claims.js";
import { registerLifecycle } from "../../coordinator/lifecycle.js";
import { Coordinator } from "../../coordinator/queue.js";
import { registerResolution } from "../../coordinator/resolution.js";
import { TimerService } from "../../coordinator/timers.js";
import { CoordinatorViews } from "../../coordinator/views.js";
import { type OpenedDatabase, openDatabase, schema } from "../../db/open.js";
import { resolveReferrer } from "../../incentives/referrals.js";
import { createLogger } from "../../logger.js";
import { createApp } from "../app.js";
import { registerAuthRoutes } from "./auth.js";
import { registerClaimRoutes } from "./claims.js";
import { registerHumanCommands, registerHumanRoutes } from "./human.js";

const BASE_URL = "https://osc.example";
const JWT_SECRET = "guest-test-secret-that-is-long-enough";
const databases: OpenedDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

function setup(overrides: Record<string, unknown> = {}) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  const config = serverConfigSchema.parse({
    GAME_POOL_TARGET: 6,
    MIN_PLY_INTERVAL_SECONDS: 1,
    RATE_LIMIT_AUTH_PER_IP_MIN: 1_000,
    RATE_LIMIT_CLAIMS_PER_IP_MIN: 1_000,
    ...overrides,
  });
  let now = 1_000_000;
  let turnstileResult: TurnstileResult = "pass";
  const turnstileCalls: string[] = [];
  const views = new CoordinatorViews();
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    now: () => now,
    views,
  });
  const timers = new TimerService({
    now: () => now,
    onFire: (kind, refId) => {
      void coordinator.dispatch({
        type: "TimerFired",
        payload: { kind, refId },
        refIds: [refId],
      });
    },
  });
  const registry = new ChessAdapterRegistry(4);
  const lifecycle = registerLifecycle({
    coordinator,
    db: database.db,
    views,
    timers,
    registry,
    config: () => config,
    rng: createRng(3),
    logger: createLogger({ level: "silent" }),
  });
  const rail = createMockRail();
  const turnstile = async (token: string): Promise<TurnstileResult> => {
    turnstileCalls.push(token);
    return turnstileResult;
  };
  const deps = {
    coordinator,
    db: database.db,
    views,
    timers,
    registry,
    lifecycle,
    config: () => config,
    rail,
    now: () => now,
    rng: createRng(7),
    jwtSecret: JWT_SECRET,
    trustProxyHops: 0,
    publicBaseUrl: BASE_URL,
    mode: () => "running" as const,
    turnstile,
  };
  registerClaimCommands(deps);
  registerResolution({
    coordinator,
    db: database.db,
    logger: createLogger({ level: "silent" }),
  });
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl: BASE_URL,
    mode: deps.mode,
  });
  registerAuthRoutes(app, { ...deps, coordinator });
  registerClaimRoutes(app, deps);
  registerHumanCommands(deps);
  registerHumanRoutes(app, deps);
  return {
    app,
    database,
    coordinator,
    views,
    turnstileCalls,
    setTurnstile: (result: TurnstileResult) => {
      turnstileResult = result;
    },
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}

type Stack = ReturnType<typeof setup>;

async function poolTick(stack: Stack): Promise<void> {
  await stack.coordinator.dispatch({ type: "PoolTick", payload: {} });
}

function postClaims(
  stack: Stack,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return stack.app.request("/api/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function guestCookieOf(res: Response): string {
  const header = res.headers
    .getSetCookie()
    .find((value) => value.startsWith("osc_guest="));
  if (header === undefined) throw new Error("osc_guest cookie missing");
  return header.split(";")[0] as string;
}

async function createGuest(
  stack: Stack,
): Promise<{ cookie: string; claim: { claimId: string }; address: string }> {
  // Step past MIN_PLY_INTERVAL so games touched by earlier guests are
  // claimable again, then let the pool refill.
  stack.setNow(stack.now() + 60_000);
  await poolTick(stack);
  const res = await postClaims(stack, {
    demo: true,
    turnstileToken: "tok-anon",
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { claim: { claimId: string } };
  const cookie = guestCookieOf(res);
  const claim = stack.database.db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.id, body.claim.claimId))
    .get();
  if (claim === undefined) throw new Error("guest claim missing");
  return { cookie, claim: body.claim, address: claim.player };
}

function nobleIdentity() {
  const seed = new Uint8Array(randomBytes(32));
  return { seed, address: algosdk.encodeAddress(ed.getPublicKey(seed)) };
}

async function makeProof(
  stack: Stack,
  identity: { seed: Uint8Array; address: string },
) {
  const challengeRes = await stack.app.request("/api/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: identity.address }),
  });
  expect(challengeRes.status).toBe(200);
  const challenge = (await challengeRes.json()) as {
    arc60Payload: { data: string };
  };
  const authData = new Uint8Array([
    ...sha256(new URL(BASE_URL).host),
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

async function verify(
  stack: Stack,
  identity: { seed: Uint8Array; address: string },
  options: { nickname?: string; guestCookie?: string; ref?: string } = {},
): Promise<Response> {
  const proof = await makeProof(stack, identity);
  return stack.app.request("/api/v1/auth/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.guestCookie === undefined
        ? {}
        : { cookie: options.guestCookie }),
    },
    body: JSON.stringify({
      address: identity.address,
      ...(options.nickname === undefined
        ? {}
        : {
            kind: "human",
            nickname: options.nickname,
            turnstileToken: "fixture-token",
          }),
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      ...proof,
    }),
  });
}

describe("guest demo sessions and link-on-login (F13)", () => {
  it("guest_creation_requires_turnstile_and_is_atomic", async () => {
    const stack = setup();

    const missing = await postClaims(stack, { demo: true });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "TURNSTILE_REQUIRED",
    );

    stack.setTurnstile("fail");
    const failed = await postClaims(stack, {
      demo: true,
      turnstileToken: "tok-bad",
    });
    expect(failed.status).toBe(400);
    expect(((await failed.json()) as { error: string }).error).toBe(
      "TURNSTILE_FAILED",
    );

    // Turnstile passes but the pool is empty: no claim can be created, so the
    // guest row must not exist either (guest + claim are one transaction).
    stack.setTurnstile("pass");
    const noGames = await postClaims(stack, {
      demo: true,
      turnstileToken: "tok-nogame",
    });
    expect(noGames.status).toBe(204);
    expect(stack.database.db.select().from(schema.players).all()).toHaveLength(
      0,
    );
    expect(
      noGames.headers.getSetCookie().some((v) => v.startsWith("osc_guest=")),
    ).toBe(false);

    await poolTick(stack);
    const created = await postClaims(stack, {
      demo: true,
      turnstileToken: "tok-good",
    });
    expect(created.status).toBe(201);
    expect(stack.turnstileCalls).toEqual(["tok-bad", "tok-nogame", "tok-good"]);
    const players = stack.database.db.select().from(schema.players).all();
    const claims = stack.database.db.select().from(schema.claims).all();
    expect(players).toHaveLength(1);
    expect(claims).toHaveLength(1);
    const guest = players[0];
    const claim = claims[0];
    if (guest === undefined || claim === undefined) throw new Error("missing");
    expect(guest.kind).toBe("guest");
    expect(guest.address).toMatch(/^guest_/);
    expect(guest.turnstileVerifiedAt).toBe(stack.now());
    expect(claim.player).toBe(guest.address);
    expect(claim.demo).toBe(true);
    expect(claim.stakeMicrousdc).toBe(0);
    expect(guestCookieOf(created)).toMatch(/^osc_guest=/);
  });

  it("guest_cookie_is_accepted_only_by_guest_claim_routes", async () => {
    const stack = setup();
    const guest = await createGuest(stack);
    const cookie = { cookie: guest.cookie };

    // Guest-scoped surfaces accept the cookie (§6.1).
    const current = await stack.app.request("/api/v1/claims/current", {
      headers: cookie,
    });
    expect(current.status).toBe(200);
    const status = await stack.app.request(
      `/api/v1/claims/${guest.claim.claimId}/status`,
      { headers: cookie },
    );
    expect(status.status).toBe(200);
    const refetch = await postClaims(stack, { demo: true }, cookie);
    expect(refetch.status).toBe(200);
    expect(
      ((await refetch.json()) as { claim: { claimId: string } }).claim.claimId,
    ).toBe(guest.claim.claimId);

    // Every other authenticated route treats the guest cookie as absent.
    const rejected: [string, RequestInit][] = [
      ["/api/v1/my/profile", { headers: cookie }],
      [
        "/api/v1/my/profile",
        {
          method: "PATCH",
          headers: { "content-type": "application/json", ...cookie },
          body: JSON.stringify({ nickname: "guest-nick" }),
        },
      ],
      ["/api/v1/my/games?status=ongoing", { headers: cookie }],
      ["/api/v1/auth/logout", { method: "POST", headers: cookie }],
    ];
    for (const [path, init] of rejected) {
      const res = await stack.app.request(path, init);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe(
        "UNAUTHENTICATED",
      );
    }

    // A wallet-kind JWT smuggled into the guest cookie is not a guest session.
    const forged = signSession(JWT_SECRET, {
      sub: guest.address,
      kind: "human",
      jti: "forged",
      iat: Math.floor(stack.now() / 1_000),
      exp: Math.floor(stack.now() / 1_000) + 3_600,
    });
    const forgedRes = await stack.app.request("/api/v1/claims/current", {
      headers: { cookie: `osc_guest=${forged}` },
    });
    expect(forgedRes.status).toBe(401);
  });

  it("guest_lifetime_allowance_is_consumed_by_move_or_expiry", async () => {
    const stack = setup();

    const moved = await createGuest(stack);
    const moveRes = await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: moved.cookie },
      body: JSON.stringify({ claimId: moved.claim.claimId, move: "e2e4" }),
    });
    expect(moveRes.status).toBe(200);
    const afterMove = await postClaims(
      stack,
      { demo: true },
      {
        cookie: moved.cookie,
      },
    );
    expect(afterMove.status).toBe(403);
    const afterMoveBody = (await afterMove.json()) as {
      error: string;
      hint: string;
    };
    expect(afterMoveBody.error).toBe("GUEST_DEMO_USED");
    expect(afterMoveBody.hint).toContain("log in");

    const expired = await createGuest(stack);
    const claimRow = stack.database.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, expired.claim.claimId))
      .get();
    if (claimRow === undefined) throw new Error("claim missing");
    stack.setNow(claimRow.deadline + 1);
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: claimRow.id },
    });
    const afterExpiry = await postClaims(
      stack,
      { demo: true },
      {
        cookie: expired.cookie,
      },
    );
    expect(afterExpiry.status).toBe(403);
    expect(((await afterExpiry.json()) as { error: string }).error).toBe(
      "GUEST_DEMO_USED",
    );
  });

  it("guest_surfaces_withhold_outcome_and_game_identity", async () => {
    const stack = setup();
    const guest = await createGuest(stack);
    const cookie = { cookie: guest.cookie };
    const claimRow = stack.database.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, guest.claim.claimId))
      .get();
    if (claimRow === undefined) throw new Error("claim missing");
    const game = stack.database.db
      .select()
      .from(schema.games)
      .where(eq(schema.games.id, claimRow.gameId))
      .get();
    if (game === undefined) throw new Error("game missing");

    const guestBodies: string[] = [];
    const capture = async (res: Response): Promise<unknown> => {
      const text = await res.text();
      guestBodies.push(text);
      return JSON.parse(text);
    };

    const current = (await capture(
      await stack.app.request("/api/v1/claims/current", { headers: cookie }),
    )) as { claim: Record<string, unknown> };
    expect(Object.keys(current.claim).sort()).toEqual([
      "claimId",
      "deadline",
      "demo",
      "fen",
      "legalMoves",
      "phase",
      "stakeMicroUsdc",
      "yourSide",
    ]);

    const openStatus = (await capture(
      await stack.app.request(`/api/v1/claims/${claimRow.id}/status`, {
        headers: cookie,
      }),
    )) as { status: string };
    expect(openStatus.status).toBe("open");

    const illegal = await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookie },
      body: JSON.stringify({ claimId: claimRow.id, move: "a1a1" }),
    });
    expect(illegal.status).toBe(400);
    const illegalBody = (await capture(illegal.clone())) as Record<
      string,
      unknown
    >;
    expect(Object.keys(illegalBody).sort()).toEqual([
      "docs",
      "error",
      "hint",
      "legalMoves",
    ]);

    const receipt = (await capture(
      await stack.app.request("/api/v1/moves", {
        method: "POST",
        headers: { "content-type": "application/json", ...cookie },
        body: JSON.stringify({ claimId: claimRow.id, move: "e2e4" }),
      }),
    )) as Record<string, unknown>;
    expect(Object.keys(receipt).sort()).toEqual([
      "debitMicroUsdc",
      "explorerUrl",
      "fenAfterYourMove",
      "move",
      "status",
      "txid",
    ]);

    const movedStatus = (await capture(
      await stack.app.request(`/api/v1/claims/${claimRow.id}/status`, {
        headers: cookie,
      }),
    )) as { status: string; receipt: Record<string, unknown> };
    expect(movedStatus.status).toBe("moved");
    expect(movedStatus.receipt).not.toHaveProperty("result");

    const noOpen = await stack.app.request("/api/v1/claims/current", {
      headers: cookie,
    });
    expect(noOpen.status).toBe(404);
    await capture(noOpen.clone());

    // Resolve the game: the outcome must produce no event row for the guest.
    stack.database.db
      .update(schema.games)
      .set({
        status: "finished",
        result: claimRow.side,
        termination: "checkmate",
        finishedAt: stack.now(),
      })
      .where(eq(schema.games.id, game.id))
      .run();
    await stack.coordinator.dispatch({
      type: "GameFinished",
      payload: { gameId: game.id },
      refIds: [game.id],
    });
    const guestEvents = stack.database.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.player, guest.address))
      .all();
    expect(guestEvents.map((event) => event.type).sort()).toEqual([
      "claim_created",
      "move_accepted",
    ]);
    for (const event of guestEvents) guestBodies.push(event.payloadJson);

    // No guest-visible body or event ever mentions outcome or game identity.
    for (const body of guestBodies) {
      expect(body).not.toContain(game.id);
      expect(body).not.toContain(game.name);
      expect(body).not.toContain("result");
      expect(body).not.toContain("termination");
      expect(body).not.toContain('"gameId"');
      expect(body).not.toContain('"history"');
      expect(body).not.toContain('"ply"');
    }
  });

  it("link_guest_is_idempotent_and_preserves_claim_invariants", async () => {
    const stack = setup();

    // Moved guest claim transfers to a fresh wallet.
    const movedGuest = await createGuest(stack);
    await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: movedGuest.cookie,
      },
      body: JSON.stringify({
        claimId: movedGuest.claim.claimId,
        move: "e2e4",
      }),
    });
    const wallet = nobleIdentity();
    const linked = await verify(stack, wallet, {
      nickname: "linking-human",
      guestCookie: movedGuest.cookie,
    });
    expect(linked.status).toBe(200);
    const linkedBody = (await linked.json()) as { linkedGuestClaims?: number };
    expect(linkedBody.linkedGuestClaims).toBe(1);
    expect(
      linked.headers
        .getSetCookie()
        .some((v) => v.startsWith("osc_guest=") && /max-age=0/i.test(v)),
    ).toBe(true);
    const transferred = stack.database.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, movedGuest.claim.claimId))
      .get();
    expect(transferred?.player).toBe(wallet.address);
    const guestRow = stack.database.db
      .select()
      .from(schema.players)
      .where(eq(schema.players.address, movedGuest.address))
      .get();
    expect(guestRow?.linkedAddress).toBe(wallet.address);
    expect(guestRow?.linkedAt).not.toBeNull();

    // The linked participation is a normal demo card in /my/games.
    const myGames = await stack.app.request("/api/v1/my/games?status=ongoing", {
      headers: {
        authorization: `Bearer ${(linkedBody as { jwt?: string }).jwt ?? ""}`,
      },
    });
    expect(myGames.status).toBe(200);
    expect(((await myGames.json()) as { items: unknown[] }).items).toHaveLength(
      1,
    );

    // A dead linked-guest token is useless everywhere.
    const dead = await stack.app.request("/api/v1/claims/current", {
      headers: { cookie: movedGuest.cookie },
    });
    expect(dead.status).toBe(401);

    // Re-verify with the already-linked cookie is a no-op.
    const again = await verify(stack, wallet, {
      guestCookie: movedGuest.cookie,
    });
    expect(again.status).toBe(200);
    expect((await again.json()) as object).not.toHaveProperty(
      "linkedGuestClaims",
    );
    const stillLinked = stack.database.db
      .select()
      .from(schema.players)
      .where(eq(schema.players.address, movedGuest.address))
      .get();
    expect(stillLinked?.linkedAddress).toBe(wallet.address);

    // I2: a moved guest claim whose side conflicts with the wallet's prior
    // participation in that game stays guest-owned; the link still happens.
    const conflictGuest = await createGuest(stack);
    const conflictClaim = stack.database.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, conflictGuest.claim.claimId))
      .get();
    if (conflictClaim === undefined) throw new Error("claim missing");
    await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: conflictGuest.cookie,
      },
      body: JSON.stringify({
        claimId: conflictGuest.claim.claimId,
        move: "e2e4",
      }),
    });
    const conflictWallet = nobleIdentity();
    const registered = await verify(stack, conflictWallet, {
      nickname: "conflict-human",
    });
    expect(registered.status).toBe(200);
    stack.database.db
      .insert(schema.claims)
      .values({
        id: "clm_conflict_prior",
        gameId: conflictClaim.gameId,
        player: conflictWallet.address,
        side: conflictClaim.side === "white" ? "black" : "white",
        demo: true,
        stakeMicrousdc: 0,
        status: "moved",
        createdAt: stack.now(),
        deadline: stack.now() + 1_000,
        movedAt: stack.now(),
        movedPly: 99,
      })
      .run();
    const conflictLink = await verify(stack, conflictWallet, {
      guestCookie: conflictGuest.cookie,
    });
    expect(conflictLink.status).toBe(200);
    expect(
      ((await conflictLink.json()) as { linkedGuestClaims?: number })
        .linkedGuestClaims,
    ).toBe(0);
    const kept = stack.database.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, conflictGuest.claim.claimId))
      .get();
    expect(kept?.player).toBe(conflictGuest.address);

    // I1: an open guest claim never transfers onto a wallet that already has
    // an open claim; without one it transfers and becomes the wallet's claim.
    const openGuestBlocked = await createGuest(stack);
    const busyWallet = nobleIdentity();
    await verify(stack, busyWallet, { nickname: "busy-human" });
    stack.setNow(stack.now() + 60_000);
    await poolTick(stack);
    const busyClaim = await stack.coordinator.dispatch<
      { player: string; kind: "human"; demo: boolean },
      { claim: ClaimRecord | null }
    >({
      type: "ClaimRequested",
      payload: { player: busyWallet.address, kind: "human", demo: true },
      claimClass: "human",
    });
    if (busyClaim.kind !== "ok" || busyClaim.result.claim === null)
      throw new Error("wallet claim unavailable");
    const blockedLink = await verify(stack, busyWallet, {
      guestCookie: openGuestBlocked.cookie,
    });
    expect(blockedLink.status).toBe(200);
    expect(
      ((await blockedLink.json()) as { linkedGuestClaims?: number })
        .linkedGuestClaims,
    ).toBe(0);
    const blockedClaim = stack.database.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, openGuestBlocked.claim.claimId))
      .get();
    expect(blockedClaim?.player).toBe(openGuestBlocked.address);
    expect(blockedClaim?.status).toBe("open");

    const openGuestFree = await createGuest(stack);
    const freeWallet = nobleIdentity();
    const freeLink = await verify(stack, freeWallet, {
      nickname: "free-human",
      guestCookie: openGuestFree.cookie,
    });
    expect(freeLink.status).toBe(200);
    expect(
      ((await freeLink.json()) as { linkedGuestClaims?: number })
        .linkedGuestClaims,
    ).toBe(1);
    const transferredOpen = stack.database.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, openGuestFree.claim.claimId))
      .get();
    expect(transferredOpen?.player).toBe(freeWallet.address);
    expect(stack.views.openClaimByPlayer.get(freeWallet.address)).toBe(
      openGuestFree.claim.claimId,
    );
  });
});

describe("referral capture (F15 step 3)", () => {
  it("referral_capture_is_first_touch_immutable_and_guest_link_aware", async () => {
    const stack = setup();
    const playerRow = (address: string) =>
      stack.database.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, address))
        .get();

    // A referrer registers and is minted their own invite slug.
    const referrer = nobleIdentity();
    expect(
      (await verify(stack, referrer, { nickname: "referrer" })).status,
    ).toBe(200);
    const refCode = playerRow(referrer.address)?.refCode;
    if (refCode == null) throw new Error("referrer ref_code not minted");
    expect(playerRow(referrer.address)?.refJoined).toBe(0);

    // (a) Direct registration with a valid ref: first-touch attribution +
    // referrer ref_joined bump; the new human also gets their own ref_code.
    const direct = nobleIdentity();
    expect(
      (await verify(stack, direct, { nickname: "direct", ref: refCode }))
        .status,
    ).toBe(200);
    expect(playerRow(direct.address)?.referredBy).toBe(referrer.address);
    expect(playerRow(direct.address)?.refCode).not.toBeNull();
    expect(playerRow(referrer.address)?.refJoined).toBe(1);

    // (b) Unknown code is ignored silently.
    const unknown = nobleIdentity();
    await verify(stack, unknown, {
      nickname: "unknownref",
      ref: "no-such-999",
    });
    expect(playerRow(unknown.address)?.referredBy).toBeNull();

    // (c) Self code is ignored (defensive; the resolver drops it).
    expect(
      resolveReferrer(stack.database.db, refCode, referrer.address),
    ).toBeNull();

    // (d) Repeated attempts never overwrite first-touch: the direct human logs
    // in again carrying a different ref — referred_by stays put.
    await verify(stack, direct, { ref: refCode });
    expect(playerRow(direct.address)?.referredBy).toBe(referrer.address);
    expect(playerRow(referrer.address)?.refJoined).toBe(1);

    // (e) Guest link propagation: a guest created with a ref, then a fresh
    // registration carrying no ref of its own inherits the guest's referrer.
    stack.setNow(stack.now() + 60_000);
    await poolTick(stack);
    const guestRes = await postClaims(stack, {
      demo: true,
      turnstileToken: "tok-ref",
      ref: refCode,
    });
    expect(guestRes.status).toBe(201);
    const guestCookie = guestCookieOf(guestRes);
    const guestClaim = (await guestRes.json()) as {
      claim: { claimId: string };
    };
    const guestAddress = stack.database.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, guestClaim.claim.claimId))
      .get()?.player;
    if (guestAddress === undefined) throw new Error("guest missing");
    expect(playerRow(guestAddress)?.referredBy).toBe(referrer.address);

    const linkedWallet = nobleIdentity();
    const linkRes = await verify(stack, linkedWallet, {
      nickname: "inheritor",
      guestCookie,
    });
    expect(linkRes.status).toBe(200);
    expect(playerRow(linkedWallet.address)?.referredBy).toBe(referrer.address);
    expect(playerRow(referrer.address)?.refJoined).toBe(2);

    // A direct ref on the registration wins over the guest's inherited one.
    stack.setNow(stack.now() + 60_000);
    await poolTick(stack);
    const other = nobleIdentity();
    await verify(stack, other, { nickname: "other-ref" });
    const otherCode = playerRow(other.address)?.refCode;
    if (otherCode == null) throw new Error("missing other ref_code");
    const guest2 = await postClaims(stack, {
      demo: true,
      turnstileToken: "tok-ref2",
      ref: refCode,
    });
    const guest2Cookie = guestCookieOf(guest2);
    const overrideWallet = nobleIdentity();
    await verify(stack, overrideWallet, {
      nickname: "override",
      guestCookie: guest2Cookie,
      ref: otherCode,
    });
    expect(playerRow(overrideWallet.address)?.referredBy).toBe(other.address);

    // A supplied but invalid direct code is ignored; it must not silently fall
    // back to the guest's stored attribution. Guest propagation applies only
    // when registration carries no direct code at all.
    stack.setNow(stack.now() + 60_000);
    await poolTick(stack);
    const guest3 = await postClaims(stack, {
      demo: true,
      turnstileToken: "tok-ref3",
      ref: refCode,
    });
    const invalidOverride = nobleIdentity();
    await verify(stack, invalidOverride, {
      nickname: "invalid-override",
      guestCookie: guestCookieOf(guest3),
      ref: "no-such-direct-code",
    });
    expect(playerRow(invalidOverride.address)?.referredBy).toBeNull();
    expect(playerRow(referrer.address)?.refJoined).toBe(2);

    // Referral propagation is part of the one successful LinkGuest command.
    // A second registration racing with the same cookie cannot inherit or bump
    // the counter after the guest has already been consumed.
    const raceGuest = "guest_referral_race";
    stack.database.db
      .insert(schema.players)
      .values({
        address: raceGuest,
        kind: "guest",
        nickname: null,
        createdAt: stack.now(),
        referredBy: referrer.address,
      })
      .run();
    const raceWallets = ["race_wallet_a", "race_wallet_b"] as const;
    for (const address of raceWallets) {
      stack.database.db
        .insert(schema.players)
        .values({
          address,
          kind: "human",
          nickname: address,
          createdAt: stack.now(),
        })
        .run();
    }
    for (const player of raceWallets) {
      await stack.coordinator.dispatch({
        type: "LinkGuest",
        payload: { guest: raceGuest, player, inheritReferral: true },
      });
    }
    expect(playerRow(raceWallets[0])?.referredBy).toBe(referrer.address);
    expect(playerRow(raceWallets[1])?.referredBy).toBeNull();
    expect(playerRow(referrer.address)?.refJoined).toBe(3);
  });
});
