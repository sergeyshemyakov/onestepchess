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
  directStakeNote,
  registerClaimCommands,
} from "../../coordinator/claims.js";
import { registerLifecycle } from "../../coordinator/lifecycle.js";
import { Coordinator } from "../../coordinator/queue.js";
import { registerResolution } from "../../coordinator/resolution.js";
import { TimerService } from "../../coordinator/timers.js";
import { CoordinatorViews } from "../../coordinator/views.js";
import { type OpenedDatabase, openDatabase, schema } from "../../db/open.js";
import { createLogger } from "../../logger.js";
import { pruneSettledPaymentIntents } from "../../operations/retention.js";
import { recoverSettlingIntents } from "../../recovery.js";
import { createApp } from "../app.js";
import { registerClaimRoutes } from "./claims.js";

const BASE_URL = "https://osc.example";
const JWT_SECRET = "claims-test-secret-that-is-long-enough";
const databases: OpenedDatabase[] = [];
const stacks: { timers: TimerService; coordinator: Coordinator }[] = [];

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
  stacks.push({ timers, coordinator });
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

afterEach(async () => {
  vi.restoreAllMocks();
  // An open agent claim arms an immediately-due reveal timer whose command
  // would otherwise run against a closed database after the test returns.
  for (const stack of stacks.splice(0)) {
    stack.timers.disarmAll();
    await stack.coordinator.onIdle();
  }
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
    expect(await recoverSettlingIntents(stack.recoveryDeps)).toMatchObject({
      nextRecoveryAt: null,
    });
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
    expect(await recoverSettlingIntents(stack.recoveryDeps)).toMatchObject({
      nextRecoveryAt: stack.now() + 1_000,
    });
    stack.setNow(stack.now() + 2_000);
    expect(await recoverSettlingIntents(stack.recoveryDeps)).toMatchObject({
      nextRecoveryAt: null,
    });

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

const USDC_ASSET = "31566704";

/** A wire-valid Algorand txid (52 base32 chars) that is unique per label. */
function stakeTxid(label: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  for (let index = 0; index < 52; index += 1) {
    const code = label.charCodeAt(index % label.length) + index;
    out += alphabet[code % alphabet.length];
  }
  return out;
}

function confirmStake(
  stack: ReturnType<typeof setup>,
  claim: ClaimRecord,
  sender: string,
  label: string,
  overrides: {
    amount?: number;
    note?: string;
    receiver?: string;
    asset?: string;
    closeTo?: string | null;
  } = {},
): string {
  return stack.rail.control.confirmAssetTransfer({
    txid: stakeTxid(label),
    sender,
    receiver: overrides.receiver ?? stack.rail.treasuryAddress,
    asset: overrides.asset ?? USDC_ASSET,
    amount: overrides.amount ?? claim.stakeMicrousdc,
    note:
      overrides.note ?? Buffer.from(directStakeNote(claim.id)).toString("utf8"),
    closeTo: overrides.closeTo ?? null,
  }).txid;
}

function directMoveRequest(
  stack: ReturnType<typeof setup>,
  claim: ClaimRecord,
  address: string,
  txid: string,
  options: { move?: string; header?: string; kind?: "human" | "agent" } = {},
): Promise<Response> {
  return stack.app.request("/api/v1/moves", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session(stack, address, options.kind ?? "agent")}`,
      "Content-Type": "application/json",
      ...(options.header === undefined
        ? {}
        : { "PAYMENT-SIGNATURE": options.header }),
    },
    body: JSON.stringify({
      claimId: claim.id,
      move: options.move ?? "e2e4",
      stakeTxid: txid,
    }),
  });
}

function balance(stack: ReturnType<typeof setup>, account: string): number {
  return (
    stack.database.db
      .select()
      .from(schema.ledgerBalances)
      .where(eq(schema.ledgerBalances.account, account))
      .get()?.balanceMicrousdc ?? 0
  );
}

function directStakeRows(stack: ReturnType<typeof setup>) {
  return stack.database.db.select().from(schema.directStakes).all();
}

function claimRow(stack: ReturnType<typeof setup>, id: string): ClaimRecord {
  const row = stack.database.db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.id, id))
    .get();
  if (row === undefined) throw new Error("claim missing");
  return row;
}

async function expireClaim(
  stack: ReturnType<typeof setup>,
  claim: ClaimRecord,
): Promise<void> {
  stack.setNow(claim.deadline + 1);
  await stack.coordinator.dispatch({
    type: "ExpireClaim",
    payload: { claimId: claim.id },
  });
}

async function statusOf(
  stack: ReturnType<typeof setup>,
  claim: ClaimRecord,
  address: string,
  kind: "human" | "agent" = "agent",
) {
  const response = await stack.app.request(
    `/api/v1/claims/${claim.id}/status`,
    { headers: { Authorization: `Bearer ${session(stack, address, kind)}` } },
  );
  return (await response.json()) as {
    status: string;
    receipt?: { txid: string | null };
    paymentState?: unknown;
  };
}

describe("direct on-chain stake payments (spec 2026-09-21)", () => {
  it("direct_stake_move_settles_without_facilitator", async () => {
    const metrics = {
      recordClaimCreated: vi.fn(),
      recordMoveSettled: vi.fn(),
      recordFacilitatorError: vi.fn(),
    };
    const stack = setup({}, metrics);
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const verify = vi.spyOn(stack.rail, "verify");
    const settle = vi.spyOn(stack.rail, "settle");
    const txid = confirmStake(stack, claim, "bot", "settles");

    const response = await directMoveRequest(stack, claim, "bot", txid);
    const receipt = moveReceiptSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(receipt.txid).toBe(txid);
    expect(receipt.explorerUrl).toBe(
      `https://explorer.perawallet.app/tx/${txid}`,
    );
    expect(receipt.debitMicroUsdc).toBe(claim.stakeMicrousdc);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(
      stack.database.db.select().from(schema.stakeEntries).get()?.payTxid,
    ).toBe(txid);
    expect(balance(stack, "treasury")).toBe(claim.stakeMicrousdc);
    expect(directStakeRows(stack)).toMatchObject([
      { txid, player: "bot", claimId: claim.id, outcome: "moved" },
    ]);
    expect(
      stack.database.db.select().from(schema.paymentIntents).all(),
    ).toHaveLength(0);
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(metrics.recordMoveSettled).toHaveBeenCalledTimes(1);
    expect(claimRow(stack, claim.id).status).toBe("moved");
  });

  it("direct_stake_replay_is_byte_identical", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const txid = confirmStake(stack, claim, "bot", "replay");
    const first = await directMoveRequest(stack, claim, "bot", txid);
    const firstBody = await first.text();
    const lookups = vi.spyOn(stack.rail, "getAssetTransfer");

    const replay = await directMoveRequest(stack, claim, "bot", txid);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
    expect(replay.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(lookups).not.toHaveBeenCalled();
    expect(directStakeRows(stack)).toHaveLength(1);
  });

  it("direct_stake_txid_cannot_migrate_claims", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 4,
      HUMAN_BOARD_RESERVE_PERCENT: 0,
    });
    await addPlayer(stack, "bot", "agent");
    await addPlayer(stack, "other", "agent");
    const first = await openClaim(stack, "bot", false, "agent");
    const txid = confirmStake(stack, first, "bot", "migrate");
    expect((await directMoveRequest(stack, first, "bot", txid)).status).toBe(
      200,
    );
    const treasuryBefore = balance(stack, "treasury");
    const protocolBefore = balance(stack, "protocol");

    const second = await openClaim(stack, "bot", false, "agent");
    const sameBot = await directMoveRequest(stack, second, "bot", txid);
    const otherClaim = await openClaim(stack, "other", false, "agent");
    const otherPlayer = await directMoveRequest(
      stack,
      otherClaim,
      "other",
      txid,
    );

    expect(sameBot.status).toBe(402);
    expect(await sameBot.json()).toMatchObject({ error: "PAYMENT_INVALID" });
    expect(sameBot.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(otherPlayer.status).toBe(402);
    expect(await otherPlayer.json()).toMatchObject({
      error: "PAYMENT_INVALID",
    });
    expect(balance(stack, "treasury")).toBe(treasuryBefore);
    expect(balance(stack, "protocol")).toBe(protocolBefore);
    expect(directStakeRows(stack)).toHaveLength(1);
    expect(claimRow(stack, second.id).status).toBe("open");
    expect(claimRow(stack, otherClaim.id).status).toBe("open");
  });

  it("direct_stake_pending_is_202_and_writes_nothing", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const txid = stakeTxid("pending");
    stack.rail.control.setAssetTransfer(txid, { status: "pending" });

    const response = await directMoveRequest(stack, claim, "bot", txid);

    expect(response.status).toBe(202);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toEqual({
      status: "payment_pending",
      claimId: claim.id,
      retryAfterSeconds: 2,
    });
    expect(claimRow(stack, claim.id).status).toBe("open");
    expect(directStakeRows(stack)).toHaveLength(0);
    expect(stack.database.db.select().from(schema.ledger).all()).toHaveLength(
      0,
    );
  });

  it("direct_stake_unknown_or_foreign_transfer_is_invalid", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const good = {
      sender: "bot",
      receiver: stack.rail.treasuryAddress,
      asset: USDC_ASSET,
      amount: claim.stakeMicrousdc,
      closeTo: null,
      note: directStakeNote(claim.id),
    };
    const cases: [
      string,
      Parameters<typeof stack.rail.control.setAssetTransfer>[1],
    ][] = [
      ["not_found", { status: "not_found", currentRound: 1 }],
      ["not_axfer", { status: "confirmed", confirmedRound: 1, transfer: null }],
      [
        "wrong_receiver",
        {
          status: "confirmed",
          confirmedRound: 1,
          transfer: { ...good, receiver: "SOMEONE_ELSE" },
        },
      ],
      [
        "wrong_asset",
        {
          status: "confirmed",
          confirmedRound: 1,
          transfer: { ...good, asset: "10458941" },
        },
      ],
      [
        "wrong_sender",
        {
          status: "confirmed",
          confirmedRound: 1,
          transfer: { ...good, sender: "other" },
        },
      ],
      [
        "close_to",
        {
          status: "confirmed",
          confirmedRound: 1,
          transfer: { ...good, closeTo: stack.rail.treasuryAddress },
        },
      ],
      [
        "no_prefix",
        {
          status: "confirmed",
          confirmedRound: 1,
          transfer: {
            ...good,
            note: new TextEncoder().encode("x402-payment-v2-abc"),
          },
        },
      ],
    ];
    for (const [label, lookup] of cases) {
      const txid = stakeTxid(label);
      stack.rail.control.setAssetTransfer(txid, lookup);
      const response = await directMoveRequest(stack, claim, "bot", txid);
      expect(response.status, label).toBe(402);
      expect(await response.json(), label).toMatchObject({
        error: "PAYMENT_INVALID",
      });
      expect(response.headers.get("PAYMENT-REQUIRED"), label).toBeNull();
    }
    expect(directStakeRows(stack)).toHaveLength(0);
    expect(stack.database.db.select().from(schema.ledger).all()).toHaveLength(
      0,
    );
    expect(claimRow(stack, claim.id).status).toBe("open");
  });

  it("direct_stake_wrong_amount_is_pocketed", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const txid = confirmStake(stack, claim, "bot", "short", {
      amount: claim.stakeMicrousdc - 1,
    });

    const response = await directMoveRequest(stack, claim, "bot", txid);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "STAKE_RETAINED",
      stakeTxid: txid,
      retainedMicroUsdc: claim.stakeMicrousdc - 1,
      claimStatus: "open",
    });
    expect(directStakeRows(stack)).toMatchObject([
      { txid, claimId: claim.id, outcome: "orphaned" },
    ]);
    expect(stack.database.db.select().from(schema.ledger).all()).toMatchObject([
      {
        account: "protocol",
        deltaMicrousdc: claim.stakeMicrousdc - 1,
        refType: "direct_orphan",
        refId: txid,
        txid,
      },
    ]);
    expect(balance(stack, "protocol")).toBe(claim.stakeMicrousdc - 1);
    expect(balance(stack, "treasury")).toBe(0);
    expect(claimRow(stack, claim.id).status).toBe("open");
    expect(
      stack.database.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.type, "direct_stake_orphaned"))
        .all()
        .map((row) => JSON.parse(row.payloadJson)),
    ).toEqual([
      { claimId: claim.id, txid, amountMicroUsdc: claim.stakeMicrousdc - 1 },
    ]);
  });

  it("direct_stake_after_expiry_is_pocketed_once", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const txid = confirmStake(stack, claim, "bot", "late");
    await expireClaim(stack, claim);
    const lookups = vi.spyOn(stack.rail, "getAssetTransfer");

    const first = await directMoveRequest(stack, claim, "bot", txid, {
      move: "not-a-move",
    });
    const again = await directMoveRequest(stack, claim, "bot", txid, {
      move: "not-a-move",
    });

    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({
      error: "STAKE_RETAINED",
      stakeTxid: txid,
      retainedMicroUsdc: claim.stakeMicrousdc,
      claimStatus: "expired",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: "STAKE_RETAINED",
      claimStatus: "expired",
    });
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(directStakeRows(stack)).toHaveLength(1);
    expect(
      stack.database.db
        .select()
        .from(schema.ledger)
        .where(eq(schema.ledger.refType, "direct_orphan"))
        .all(),
    ).toHaveLength(1);
    expect(balance(stack, "protocol")).toBe(claim.stakeMicrousdc);
  });

  it("direct_stake_note_for_other_claim_is_pocketed", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const txid = confirmStake(stack, claim, "bot", "othernote", {
      note: "osc:stake:clm_someone_else",
    });

    const response = await directMoveRequest(stack, claim, "bot", txid);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "STAKE_RETAINED",
      stakeTxid: txid,
      retainedMicroUsdc: claim.stakeMicrousdc,
      claimStatus: "open",
    });
    expect(directStakeRows(stack)).toMatchObject([
      { txid, outcome: "orphaned" },
    ]);
    expect(balance(stack, "protocol")).toBe(claim.stakeMicrousdc);
    expect(claimRow(stack, claim.id).status).toBe("open");
  });

  it("x402_settlement_txid_is_not_a_direct_stake", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 4,
      HUMAN_BOARD_RESERVE_PERCENT: 0,
    });
    await addPlayer(stack, "bot", "agent");
    const paid = await openClaim(stack, "bot", false, "agent");
    const header = paymentHeader(stack.rail, paid, "bot", "x402-first");
    const settled = await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session(stack, "bot", "agent")}`,
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": header,
      },
      body: JSON.stringify({ claimId: paid.id, move: "e2e4" }),
    });
    expect(settled.status).toBe(200);
    // The mock settles under a `mocktx_` id; a real settlement is a chain
    // txid, so rewrite the booked row to a wire-valid one and expose the same
    // transfer on the mock chain.
    const settleTxid = stakeTxid("x402settle");
    stack.database.db
      .update(schema.stakeEntries)
      .set({ payTxid: settleTxid })
      .where(eq(schema.stakeEntries.claimId, paid.id))
      .run();
    const next = await openClaim(stack, "bot", false, "agent");
    const ledgerBefore = stack.database.db.select().from(schema.ledger).all();

    stack.rail.control.setAssetTransfer(settleTxid, {
      status: "confirmed",
      confirmedRound: 5,
      transfer: {
        sender: "bot",
        receiver: stack.rail.treasuryAddress,
        asset: USDC_ASSET,
        amount: next.stakeMicrousdc,
        closeTo: null,
        note: new TextEncoder().encode("x402-payment-v2-nonce"),
      },
    });
    const realistic = await directMoveRequest(stack, next, "bot", settleTxid);
    stack.rail.control.setAssetTransfer(settleTxid, {
      status: "confirmed",
      confirmedRound: 5,
      transfer: {
        sender: "bot",
        receiver: stack.rail.treasuryAddress,
        asset: USDC_ASSET,
        amount: next.stakeMicrousdc,
        closeTo: null,
        note: directStakeNote(next.id),
      },
    });
    const beltAndBraces = await directMoveRequest(
      stack,
      next,
      "bot",
      settleTxid,
    );

    expect(realistic.status).toBe(402);
    expect(await realistic.json()).toMatchObject({ error: "PAYMENT_INVALID" });
    expect(beltAndBraces.status).toBe(402);
    expect(await beltAndBraces.json()).toMatchObject({
      error: "PAYMENT_INVALID",
    });
    expect(stack.database.db.select().from(schema.ledger).all()).toEqual(
      ledgerBefore,
    );
    expect(directStakeRows(stack)).toHaveLength(0);
    expect(claimRow(stack, next.id).status).toBe("open");
  });

  it("illegal_move_with_direct_stake_costs_nothing", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const txid = confirmStake(stack, claim, "bot", "illegal");
    const lookups = vi.spyOn(stack.rail, "getAssetTransfer");

    const illegal = await directMoveRequest(stack, claim, "bot", txid, {
      move: "e2e5",
    });
    const illegalBody = (await illegal.json()) as {
      error: string;
      legalMoves?: unknown[];
    };
    expect(illegal.status).toBe(400);
    expect(illegalBody.error).toBe("ILLEGAL_MOVE");
    expect(illegalBody.legalMoves?.length).toBeGreaterThan(0);
    expect(lookups).not.toHaveBeenCalled();
    expect(directStakeRows(stack)).toHaveLength(0);
    expect(stack.database.db.select().from(schema.ledger).all()).toHaveLength(
      0,
    );

    const legal = await directMoveRequest(stack, claim, "bot", txid);
    expect(legal.status).toBe(200);
    expect(moveReceiptSchema.parse(await legal.json()).txid).toBe(txid);
    expect(lookups).toHaveBeenCalledTimes(1);
  });

  it("direct_stake_rejects_mixed_payment_and_demo", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "bot", false, "agent");
    const txid = confirmStake(stack, claim, "bot", "mixed");
    const lookups = vi.spyOn(stack.rail, "getAssetTransfer");

    const mixed = await directMoveRequest(stack, claim, "bot", txid, {
      header: paymentHeader(stack.rail, claim, "bot", "mixed"),
    });
    expect(mixed.status).toBe(400);
    expect(await mixed.json()).toMatchObject({ error: "INVALID_REQUEST" });

    const demo = await openClaim(stack, "alice", true);
    const onDemo = await directMoveRequest(stack, demo, "alice", txid, {
      kind: "human",
    });
    expect(onDemo.status).toBe(400);
    expect(await onDemo.json()).toMatchObject({ error: "INVALID_REQUEST" });

    const malformed = await directMoveRequest(stack, claim, "bot", "mocktx_1");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "INVALID_REQUEST" });

    expect(lookups).not.toHaveBeenCalled();
    expect(directStakeRows(stack)).toHaveLength(0);
    expect(claimRow(stack, claim.id).status).toBe("open");
    expect(claimRow(stack, demo.id).status).toBe("open");
  });

  it("direct_stake_race_with_expiry_is_serialized", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const txid = confirmStake(stack, claim, "bot", "race");
    const lookup = stack.rail.getAssetTransfer.bind(stack.rail);
    // The route has already accepted the move as legal when the chain lookup
    // runs; the deadline passes (and the expiry timer fires) before the
    // coordinator command gets its turn.
    vi.spyOn(stack.rail, "getAssetTransfer").mockImplementation(
      async (id: string) => {
        await expireClaim(stack, claim);
        return lookup(id);
      },
    );

    const response = await directMoveRequest(stack, claim, "bot", txid);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "STAKE_RETAINED",
      stakeTxid: txid,
      retainedMicroUsdc: claim.stakeMicrousdc,
      claimStatus: "expired",
    });
    expect(claimRow(stack, claim.id).status).toBe("expired");
    expect(directStakeRows(stack)).toMatchObject([
      { txid, outcome: "orphaned" },
    ]);
    expect(
      stack.database.db.select().from(schema.stakeEntries).all(),
    ).toHaveLength(0);
    expect(balance(stack, "protocol")).toBe(claim.stakeMicrousdc);
  });

  it("receipt_survives_intent_pruning", async () => {
    const stack = setup({
      GAME_POOL_TARGET: 4,
      HUMAN_BOARD_RESERVE_PERCENT: 0,
    });
    await addPlayer(stack, "bot", "agent");
    const paid = await openClaim(stack, "bot", false, "agent");
    const settled = await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session(stack, "bot", "agent")}`,
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentHeader(stack.rail, paid, "bot", "prune"),
      },
      body: JSON.stringify({ claimId: paid.id, move: "e2e4" }),
    });
    const x402Txid = moveReceiptSchema.parse(await settled.json()).txid;
    const direct = await openClaim(stack, "bot", false, "agent");
    const directTxid = confirmStake(stack, direct, "bot", "prune-direct");
    expect(
      (await directMoveRequest(stack, direct, "bot", directTxid)).status,
    ).toBe(200);

    stack.setNow(stack.now() + 1);
    expect(pruneSettledPaymentIntents(stack.database.db, stack.now(), 0)).toBe(
      1,
    );
    expect(
      stack.database.db.select().from(schema.paymentIntents).all(),
    ).toHaveLength(0);

    const paidStatus = await statusOf(stack, paid, "bot");
    const directStatus = await statusOf(stack, direct, "bot");
    expect(paidStatus).toMatchObject({
      status: "moved",
      receipt: { txid: x402Txid },
    });
    expect(directStatus).toMatchObject({
      status: "moved",
      receipt: { txid: directTxid },
    });
  });

  it("direct_stake_after_concurrent_x402_move_is_pocketed", async () => {
    const stack = setup();
    await addPlayer(stack, "bot", "agent");
    const claim = await openClaim(stack, "bot", false, "agent");
    const settled = await stack.app.request("/api/v1/moves", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session(stack, "bot", "agent")}`,
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentHeader(stack.rail, claim, "bot", "won"),
      },
      body: JSON.stringify({ claimId: claim.id, move: "e2e4" }),
    });
    const x402Txid = moveReceiptSchema.parse(await settled.json()).txid;
    const directTxid = confirmStake(stack, claim, "bot", "lost-race");

    const response = await directMoveRequest(stack, claim, "bot", directTxid);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "STAKE_RETAINED",
      stakeTxid: directTxid,
      retainedMicroUsdc: claim.stakeMicrousdc,
      claimStatus: "moved",
    });
    expect(directStakeRows(stack)).toMatchObject([
      { txid: directTxid, outcome: "orphaned" },
    ]);
    expect(balance(stack, "protocol")).toBe(claim.stakeMicrousdc);
    expect(balance(stack, "treasury")).toBe(claim.stakeMicrousdc);
    expect(await statusOf(stack, claim, "bot")).toMatchObject({
      status: "moved",
      receipt: { txid: x402Txid },
    });
  });
});
