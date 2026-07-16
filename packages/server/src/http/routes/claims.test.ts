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

function setup(overrides: Record<string, unknown> = {}) {
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
): Promise<void> {
  stack.database.db
    .insert(schema.players)
    .values({
      address,
      kind: "human",
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
): Promise<ClaimRecord> {
  const result = await stack.coordinator.dispatch<
    { player: string; kind: "human"; demo: boolean },
    { claim: ClaimRecord | null }
  >({
    type: "ClaimRequested",
    payload: { player: address, kind: "human", demo },
    claimClass: "human",
  });
  if (result.kind !== "ok" || result.result.claim === null)
    throw new Error("claim unavailable");
  return result.result.claim;
}

function session(stack: ReturnType<typeof setup>, address: string): string {
  return signSession(JWT_SECRET, {
    sub: address,
    kind: "human",
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
    resource: `${BASE_URL}/api/v1/claims/${claim.id}/move`,
  });
  return buildMockHeader({ challenge, from: address, nonce });
}

function moveRequest(
  stack: ReturnType<typeof setup>,
  claim: ClaimRecord,
  address: string,
  header: string,
): Promise<Response> {
  return stack.app.request(`/api/v1/claims/${claim.id}/move`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session(stack, address)}`,
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": header,
    },
    body: JSON.stringify({ move: "e2e4" }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
});

describe("staked claim moves (F4)", () => {
  it("returns a durable paid receipt, updates both ledger views, and replays byte-identically", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice");
    const header = paymentHeader(stack.rail, claim, "alice", "replay");

    const first = await moveRequest(stack, claim, "alice", header);
    const firstBody = await first.json();
    const firstResponseHeader = first.headers.get("PAYMENT-RESPONSE");
    const replay = await moveRequest(stack, claim, "alice", header);

    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({
      status: "moved",
      debitMicroUsdc: claim.stakeMicrousdc,
      explorerUrl: expect.stringContaining("/tx/mocktx_"),
    });
    expect(firstResponseHeader).not.toBeNull();
    expect(await replay.json()).toEqual(firstBody);
    expect(replay.headers.get("PAYMENT-RESPONSE")).toBe(firstResponseHeader);
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

describe("demo claim moves (F4 demo variant)", () => {
  it("returns the exact zero-debit receipt and creates no payment or ledger rows", async () => {
    const stack = setup();
    await addPlayer(stack, "alice");
    const claim = await openClaim(stack, "alice", true);

    const response = await stack.app.request(
      `/api/v1/claims/${claim.id}/move`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session(stack, "alice")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ move: "e4" }),
      },
    );
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
});
