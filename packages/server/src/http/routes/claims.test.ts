import {
  claimStatusViewSchema,
  claimViewSchema,
  moveReceiptSchema,
} from "@onestepchess/agent-kit";
import { createRng } from "@onestepchess/core";
import {
  buildMockHeader,
  createMockRail,
  type MockRail,
} from "@onestepchess/rail-mock";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../../auth/jwt.js";
import { type ServerConfig, serverConfigSchema } from "../../config.js";
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
import { createLogger } from "../../logger.js";
import { recoverSettlingIntents } from "../../recovery.js";
import { createApp } from "../app.js";
import { registerClaimRoutes } from "./claims.js";

const BASE_URL = "https://osc.example";
const JWT_SECRET = "claims-test-secret-that-is-long-enough";
const databases: OpenedDatabase[] = [];

function setup(
  overrides: Record<string, unknown> = {},
  metrics?: {
    recordClaimCreated(): void;
    recordMoveSettled(latencyMs: number): void;
    recordFacilitatorError(): void;
  },
) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  const config: ServerConfig = serverConfigSchema.parse({
    GAME_POOL_TARGET: 2,
    ...overrides,
  });
  let now = 1_000_000;
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
    metrics,
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
  registerClaimRoutes(app, deps);
  return {
    app,
    database,
    coordinator,
    rail,
    recoveryDeps: deps,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}

async function addPlayer(
  stack: ReturnType<typeof setup>,
  address: string,
  kind: "human" | "agent" = "human",
): Promise<void> {
  stack.database.db
    .insert(schema.players)
    .values({
      address,
      kind,
      nickname: address,
      createdAt: stack.now(),
    })
    .run();
  await stack.coordinator.dispatch({ type: "PoolTick", payload: {} });
}

async function openClaim(
  stack: ReturnType<typeof setup>,
  address: string,
  demo = false,
  kind: "human" | "agent" = "human",
): Promise<ClaimRecord> {
  const result = await stack.coordinator.dispatch<
    { player: string; kind: "human" | "agent"; demo: boolean },
    { claim: ClaimRecord | null }
  >({
    type: "ClaimRequested",
    payload: { player: address, kind, demo },
    claimClass: kind,
  });
  if (result.kind !== "ok" || result.result.claim === null)
    throw new Error("claim unavailable");
  return result.result.claim;
}

function session(
  stack: ReturnType<typeof setup>,
  address: string,
  kind: "human" | "agent" = "human",
): string {
  return signSession(JWT_SECRET, {
    sub: address,
    kind,
    jti: `jti-${address}`,
    iat: Math.floor(stack.now() / 1_000),
    exp: Math.floor(stack.now() / 1_000) + 3_600,
  });
}

function paymentHeader(
  rail: MockRail,
  claim: ClaimRecord,
  address: string,
  nonce: string,
): string {
  const challenge = rail.buildPaymentChallenge({
    amountMicroUsdc: claim.stakeMicrousdc,
    resource: `${BASE_URL}/api/v1/moves`,
  });
  return buildMockHeader({ challenge, from: address, nonce });
}

function moveRequest(
  stack: ReturnType<typeof setup>,
  claim: ClaimRecord,
  address: string,
  header?: string,
): Promise<Response> {
  return stack.app.request("/api/v1/moves", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session(stack, address)}`,
      "Content-Type": "application/json",
      ...(header === undefined ? {} : { "PAYMENT-SIGNATURE": header }),
    },
    body: JSON.stringify({ claimId: claim.id, move: "e2e4" }),
  });
}

function decodeChallenge(response: Response): {
  resource: { url: string };
  accepts: { amount: string }[];
} {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (header === null) throw new Error("missing PAYMENT-REQUIRED");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
});

describe("staked claim moves (F4)", () => {
  it("agent_surfaces_are_position_only_and_schema_compatible", async () => {
    const stack = setup();
    await addPlayer(stack, "agent-one", "agent");
    const claim = await openClaim(stack, "agent-one", false, "agent");
    const authorization = `Bearer ${session(stack, "agent-one", "agent")}`;

    const currentResponse = await stack.app.request("/api/v1/claims/current", {
      headers: { Authorization: authorization },
    });
    const current = (await currentResponse.json()) as { claim: unknown };
    const parsedClaim = claimViewSchema.parse(current.claim);
    expect(parsedClaim).not.toHaveProperty("gameId");
    expect(parsedClaim).not.toHaveProperty("name");
    expect(parsedClaim).not.toHaveProperty("ply");
    expect(parsedClaim).not.toHaveProperty("history");

    const header = paymentHeader(
      stack.rail,
      claim,
      "agent-one",
      "agent-contract",
    );
    const movedResponse = await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": header,
      },
      body: JSON.stringify({ claimId: claim.id, move: "e2e4" }),
    });
    moveReceiptSchema.parse(await movedResponse.json());
    expect(
      stack.database.db
        .select({ kind: schema.stakeEntries.kind })
        .from(schema.stakeEntries)
        .get()?.kind,
    ).toBe("agent");

    const statusResponse = await stack.app.request(
      `/api/v1/claims/${claim.id}/status`,
      { headers: { Authorization: authorization } },
    );
    claimStatusViewSchema.parse(await statusResponse.json());
  });

  it("returns a durable paid receipt, updates both ledger views, and replays byte-identically", async () => {
    const metrics = {
      recordClaimCreated: vi.fn(),
      recordMoveSettled: vi.fn(),
      recordFacilitatorError: vi.fn(),
    };
    const stack = setup({}, metrics);
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice");
    const header = paymentHeader(stack.rail, claim, "alice", "replay");

    const first = await moveRequest(stack, claim, "alice", header);
    const firstBody = await first.json();
    const firstResponseHeader = first.headers.get("PAYMENT-RESPONSE");
    const replay = await moveRequest(stack, claim, "alice", header);
    const unsignedReplay = await moveRequest(stack, claim, "alice");

    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({
      status: "moved",
      debitMicroUsdc: claim.stakeMicrousdc,
      explorerUrl: expect.stringContaining("/tx/mocktx_"),
    });
    expect(firstResponseHeader).not.toBeNull();
    expect(await replay.json()).toEqual(firstBody);
    expect(replay.headers.get("PAYMENT-RESPONSE")).toBe(firstResponseHeader);
    expect(await unsignedReplay.json()).toEqual(firstBody);
    expect(unsignedReplay.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(metrics.recordMoveSettled).toHaveBeenCalledTimes(1);
    expect(
      stack.database.db.select().from(schema.stakeEntries).all(),
    ).toHaveLength(1);
    expect(
      stack.database.db
        .select()
        .from(schema.ledgerBalances)
        .where(eq(schema.ledgerBalances.account, "treasury"))
        .get()?.balanceMicrousdc,
    ).toBe(claim.stakeMicrousdc);
  });

  it("rejects a client txid already owned by another player without leaking its receipt", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    await addPlayer(stack, "bob");
    const aliceClaim = await openClaim(stack, "alice");
    const aliceHeader = paymentHeader(
      stack.rail,
      aliceClaim,
      "alice",
      "shared",
    );
    expect(
      (await moveRequest(stack, aliceClaim, "alice", aliceHeader)).status,
    ).toBe(200);
    const bobClaim = await openClaim(stack, "bob");
    const bobHeader = paymentHeader(stack.rail, bobClaim, "bob", "shared");

    const response = await moveRequest(stack, bobClaim, "bob", bobHeader);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(402);
    expect(body.error).toBe("PAYMENT_INVALID");
    expect(JSON.stringify(body)).not.toContain("fenAfterYourMove");
  });

  it("persists the intent before verify and replays a stored failure without another rail call", async () => {
    const stack = setup({ CLAIM_TTL_HUMAN: 1 });
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice");
    const header = paymentHeader(stack.rail, claim, "alice", "failure");
    const verify = vi
      .spyOn(stack.rail, "verify")
      .mockImplementation(async () => {
        expect(
          stack.database.db
            .select({ status: schema.paymentIntents.status })
            .from(schema.paymentIntents)
            .get(),
        ).toEqual({ status: "verified" });
        stack.setNow(claim.deadline);
        await stack.coordinator.dispatch({
          type: "ExpireClaim",
          payload: { claimId: claim.id },
        });
        expect(
          stack.database.db
            .select({ status: schema.claims.status })
            .from(schema.claims)
            .where(eq(schema.claims.id, claim.id))
            .get(),
        ).toEqual({ status: "open" });
        return { ok: false, reason: "insufficient_funds" };
      });

    const first = await moveRequest(stack, claim, "alice", header);
    const replay = await moveRequest(stack, claim, "alice", header);
    const firstBody = (await first.json()) as { error: string };
    const replayBody = (await replay.json()) as { error: string };

    expect(first.status).toBe(402);
    expect(firstBody.error).toBe("INSUFFICIENT_FUNDS");
    expect(replayBody.error).toBe("INSUFFICIENT_FUNDS");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(
      stack.database.db
        .select({ status: schema.claims.status })
        .from(schema.claims)
        .where(eq(schema.claims.id, claim.id))
        .get(),
    ).toEqual({ status: "expired" });
  });

  it("rejects a concurrent signature before a second rail verification", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice");
    const firstHeader = paymentHeader(stack.rail, claim, "alice", "first");
    const secondHeader = paymentHeader(stack.rail, claim, "alice", "second");
    let releaseVerify: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const verify = vi
      .spyOn(stack.rail, "verify")
      .mockImplementation(async () => {
        markStarted?.();
        await gate;
        return { ok: false, reason: "invalid_payment" };
      });

    const first = moveRequest(stack, claim, "alice", firstHeader);
    await started;
    const second = await moveRequest(stack, claim, "alice", secondHeader);
    releaseVerify?.();
    await first;

    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("PAYMENT_IN_FLIGHT");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("recovers an ambiguously applied settle without charging or committing twice", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice");
    const header = paymentHeader(
      stack.rail,
      claim,
      "alice",
      "ambiguous-applied",
    );
    stack.rail.control.queueSettle({
      ok: false,
      reason: "unavailable",
      applied: true,
    });

    const pending = await moveRequest(stack, claim, "alice", header);
    expect(pending.status).toBe(202);
    expect(await recoverSettlingIntents(stack.recoveryDeps)).toBeNull();
    const replay = await moveRequest(stack, claim, "alice", header);

    expect(replay.status).toBe(200);
    expect(
      stack.database.db.select().from(schema.stakeEntries).all(),
    ).toHaveLength(1);
    expect(stack.database.db.select().from(schema.ledger).all()).toHaveLength(
      1,
    );
  });

  it("fails an ambiguously unapplied settle at the finite recovery boundary", async () => {
    const stack = setup({ PAYMENT_RECOVERY_TIMEOUT_SECONDS: 2 });
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice");
    const header = paymentHeader(
      stack.rail,
      claim,
      "alice",
      "ambiguous-unapplied",
    );
    stack.rail.control.queueSettle({
      ok: false,
      reason: "unavailable",
      applied: false,
    });

    expect((await moveRequest(stack, claim, "alice", header)).status).toBe(202);
    expect(await recoverSettlingIntents(stack.recoveryDeps)).toBe(
      stack.now() + 1_000,
    );
    stack.setNow(stack.now() + 2_000);
    expect(await recoverSettlingIntents(stack.recoveryDeps)).toBeNull();

    expect(
      stack.database.db
        .select({ status: schema.paymentIntents.status })
        .from(schema.paymentIntents)
        .get(),
    ).toEqual({ status: "failed" });
    expect(stack.database.db.select().from(schema.stakeEntries).all()).toEqual(
      [],
    );
    expect(stack.database.db.select().from(schema.ledger).all()).toEqual([]);
  });
});

describe("stable x402 move resource (2026-08-20 spec)", () => {
  it("stable_challenge_url_is_byte_identical_across_claims", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    await addPlayer(stack, "bob");
    const aliceClaim = await openClaim(stack, "alice");
    const bobClaim = await openClaim(stack, "bob");

    const aliceResponse = await moveRequest(stack, aliceClaim, "alice");
    const bobResponse = await moveRequest(stack, bobClaim, "bob");

    expect(aliceResponse.status).toBe(402);
    expect(bobResponse.status).toBe(402);
    const aliceChallenge = decodeChallenge(aliceResponse);
    const bobChallenge = decodeChallenge(bobResponse);
    expect(aliceChallenge.resource.url).toBe(`${BASE_URL}/api/v1/moves`);
    expect(aliceChallenge.resource.url).not.toContain(aliceClaim.id);
    expect(bobChallenge.resource.url).not.toContain(bobClaim.id);
    expect(JSON.stringify(aliceChallenge.resource)).toBe(
      JSON.stringify(bobChallenge.resource),
    );
  });

  it("submitted_header_cannot_migrate_claims", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    const claimA = await openClaim(stack, "alice");
    const header = paymentHeader(stack.rail, claimA, "alice", "migrate");
    expect((await moveRequest(stack, claimA, "alice", header)).status).toBe(
      200,
    );
    const claimB = await openClaim(stack, "alice");
    expect(claimB.id).not.toBe(claimA.id);

    const response = await moveRequest(stack, claimB, "alice", header);

    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe("PAYMENT_INVALID");
    expect(
      stack.database.db
        .select({ status: schema.claims.status })
        .from(schema.claims)
        .where(eq(schema.claims.id, claimB.id))
        .get(),
    ).toEqual({ status: "open" });
  });

  it("never_submitted_header_is_endpoint_authorized", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    await addPlayer(stack, "bob");
    const claimA = await openClaim(stack, "alice");
    const header = paymentHeader(stack.rail, claimA, "alice", "stale");
    stack.setNow(claimA.deadline);
    await stack.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: claimA.id },
    });
    const claimB = await openClaim(stack, "alice");
    expect(claimB.stakeMicrousdc).toBe(claimA.stakeMicrousdc);
    const bobClaim = await openClaim(stack, "bob");
    const verify = vi.spyOn(stack.rail, "verify");

    const foreign = await moveRequest(stack, bobClaim, "bob", header);
    expect(foreign.status).toBe(402);
    expect((await foreign.json()).error).toBe("PAYMENT_INVALID");
    expect(verify).not.toHaveBeenCalled();

    const settled = await moveRequest(stack, claimB, "alice", header);
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({
      status: "moved",
      debitMicroUsdc: claimB.stakeMicrousdc,
    });
    expect(
      stack.database.db
        .select({ claimId: schema.paymentIntents.claimId })
        .from(schema.paymentIntents)
        .get(),
    ).toEqual({ claimId: claimB.id });
  });

  it("other_players_claim_id_fails_ownership_before_payment", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    await addPlayer(stack, "bob");
    const aliceClaim = await openClaim(stack, "alice");
    const bobHeader = paymentHeader(stack.rail, aliceClaim, "bob", "intrude");
    const verify = vi.spyOn(stack.rail, "verify");

    const response = await moveRequest(stack, aliceClaim, "bob", bobHeader);

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("NOT_YOUR_CLAIM");
    expect(verify).not.toHaveBeenCalled();
    expect(
      stack.database.db.select().from(schema.paymentIntents).all(),
    ).toEqual([]);
  });

  it("old_move_route_is_a_tombstone_without_a_challenge", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice");

    const response = await stack.app.request(
      `/api/v1/claims/${claim.id}/move`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session(stack, "alice")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ move: "e2e4" }),
      },
    );
    const body = (await response.json()) as { error: string; hint: string };

    expect(response.status).toBe(410);
    expect(body.error).toBe("ENDPOINT_RETIRED");
    expect(body.hint).toContain("/api/v1/moves");
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });
});

describe("demo claim moves (F4 demo variant)", () => {
  it("demo_move_settles_on_the_stable_route_without_payment", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice", true);

    const response = await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session(stack, "alice")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ claimId: claim.id, move: "e4" }),
    });
    const receipt = await response.json();
    const status = await stack.app.request(
      `/api/v1/claims/${claim.id}/status`,
      { headers: { Authorization: `Bearer ${session(stack, "alice")}` } },
    );

    expect(response.status).toBe(200);
    expect(receipt).toEqual({
      status: "moved",
      move: { uci: "e2e4", san: "e4" },
      debitMicroUsdc: 0,
      txid: null,
      explorerUrl: null,
      fenAfterYourMove: expect.any(String),
    });
    expect(await status.json()).toEqual({ status: "moved", receipt });
    expect(
      stack.database.db.select().from(schema.paymentIntents).all(),
    ).toEqual([]);
    expect(stack.database.db.select().from(schema.stakeEntries).all()).toEqual(
      [],
    );
    expect(stack.database.db.select().from(schema.ledger).all()).toEqual([]);
  });
});

describe("claim request priority (F3/F5)", () => {
  it("records only a newly-created claim, not get-or-create replays", async () => {
    const metrics = {
      recordClaimCreated: vi.fn(),
      recordMoveSettled: vi.fn(),
      recordFacilitatorError: vi.fn(),
    };
    const stack = setup({}, metrics);
    await addPlayer(stack, "alice");
    const request = () =>
      stack.app.request("/api/v1/claims", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session(stack, "alice")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ demo: false }),
      });

    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(200);
    expect(metrics.recordClaimCreated).toHaveBeenCalledTimes(1);
  });

  it("routes an abandonment-deprioritized player through the soft-priority class", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    stack.database.db
      .update(schema.players)
      .set({ deprioritizedUntil: stack.now() + 60_000 })
      .where(eq(schema.players.address, "alice"))
      .run();
    const dispatch = vi.spyOn(stack.coordinator, "dispatch");

    const response = await stack.app.request("/api/v1/claims", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session(stack, "alice")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ demo: false }),
    });

    expect(response.status).toBe(201);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ClaimRequested",
        claimClass: "deprioritized",
      }),
    );
  });

  it("returns retry only to agents when the human board reserve is reached", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 4,
      HUMAN_BOARD_RESERVE_PERCENT: 25,
      TIMER_REVEAL_SECONDS: 1,
    });
    for (const address of ["agent-1", "agent-2", "agent-3", "agent-4"]) {
      await addPlayer(stack, address, "agent");
    }
    await addPlayer(stack, "human");
    for (const address of ["agent-1", "agent-2", "agent-3"]) {
      await openClaim(stack, address, false, "agent");
    }

    const request = (address: string, kind: "human" | "agent") =>
      stack.app.request("/api/v1/claims", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session(stack, address, kind)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ demo: false }),
      });
    const agent = await request("agent-4", "agent");
    const human = await request("human", "human");

    expect(agent.status).toBe(204);
    expect(agent.headers.get("Retry-After")).toBe("1");
    expect(human.status).toBe(201);
  });
});
