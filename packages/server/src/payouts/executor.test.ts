import { STARTING_FEN } from "@onestepchess/core";
import {
  buildMockHeader,
  createMockRail,
  createMockRailState,
  type MockRailState,
} from "@onestepchess/rail-mock";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type ServerConfig, serverConfigSchema } from "../config.js";
import { Coordinator } from "../coordinator/queue.js";
import { registerResolution } from "../coordinator/resolution.js";
import {
  type Db,
  type OpenedDatabase,
  openDatabase,
  schema,
} from "../db/open.js";
import { createLogger } from "../logger.js";
import { registerPayoutCommands, runPayoutExecutor } from "./executor.js";

const databases: OpenedDatabase[] = [];
const RULES_JSON = JSON.stringify(
  serverConfigSchema.parse({}) as unknown as Record<string, unknown>,
);

afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

const TREASURY = "MOCK_TREASURY";
const INITIAL = 10_000_000;

function makeStack(
  overrides: Record<string, unknown> = {},
  sharedState?: MockRailState,
) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  const config: ServerConfig = serverConfigSchema.parse({
    PAYOUT_BATCH_MAX: 16,
    PAYOUT_MAX_ATTEMPTS: 10,
    PAYMENT_RECOVERY_TIMEOUT_SECONDS: 2,
    ...overrides,
  });
  const state = sharedState ?? createMockRailState({ usdcMicroUsdc: INITIAL });
  let now = 5_000_000;
  const nowFn = () => now;

  function build() {
    const rail = createMockRail({ state, treasuryAddress: TREASURY });
    const coordinator = new Coordinator({
      sqlite: database.sqlite,
      db: database.db,
      logger: createLogger({ level: "silent" }),
      now: nowFn,
    });
    const deps = {
      coordinator,
      db: database.db,
      rail,
      config: () => config,
      now: nowFn,
      logger: createLogger({ level: "silent" }),
    };
    registerPayoutCommands(deps);
    registerResolution({
      coordinator,
      db: database.db,
      logger: createLogger({ level: "silent" }),
    });
    return { rail, coordinator, deps };
  }

  let current = build();
  database.db
    .insert(schema.systemState)
    .values({
      id: 1,
      railKind: "mock",
      caip2: "mock:local",
      usdcAsset: "31566704",
      treasuryAddress: TREASURY,
      updatedAt: now,
    })
    .run();

  return {
    db: database.db,
    state,
    get rail() {
      return current.rail;
    },
    get coordinator() {
      return current.coordinator;
    },
    run: () => runPayoutExecutor(current.deps),
    reboot: () => {
      current = build();
    },
    setNow: (value: number) => {
      now = value;
    },
    now: nowFn,
  };
}

function seedGame(db: Db, now: number, gameId: string): void {
  db.insert(schema.games)
    .values({
      id: gameId,
      name: `payout-${gameId}`,
      status: "finished",
      fen: STARTING_FEN,
      rulesJson: RULES_JSON,
      lastPlyAt: now,
      createdAt: now,
      result: "white",
      termination: "checkmate",
      finishedAt: now,
      resolvedAt: now,
    })
    .run();
}

function seedJob(
  db: Db,
  now: number,
  args: {
    id: string;
    gameId: string;
    recipient: string;
    amount: number;
    reason?: "resolution" | "refund";
    status?: "pending" | "prepared" | "submitted";
    batchId?: string;
    txid?: string;
  },
): void {
  db.insert(schema.payoutJobs)
    .values({
      id: args.id,
      gameId: args.gameId,
      recipient: args.recipient,
      amount: args.amount,
      reason: args.reason ?? "resolution",
      status: args.status ?? "pending",
      batchId: args.batchId ?? null,
      txid: args.txid ?? null,
      createdAt: now,
    })
    .run();
}

async function drain(
  stack: ReturnType<typeof makeStack>,
  maxTicks = 30,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    const next = await stack.run();
    if (next === null) return;
    if (next > stack.now()) return;
  }
}

async function treasuryUsdc(
  stack: ReturnType<typeof makeStack>,
): Promise<number> {
  const balances = await stack.rail.getBalances(TREASURY);
  return balances.usdcMicroUsdc;
}

describe("payout executor — happy path (F7 step 3)", () => {
  it("drives a pending job to confirmed with one ledger debit and an event", async () => {
    const stack = makeStack();
    seedGame(stack.db, stack.now(), "gm_pay");
    seedJob(stack.db, stack.now(), {
      id: "pj_1",
      gameId: "gm_pay",
      recipient: "alice",
      amount: 15_000,
    });

    await drain(stack);

    const job = stack.db
      .select()
      .from(schema.payoutJobs)
      .where(eq(schema.payoutJobs.id, "pj_1"))
      .get();
    expect(job?.status).toBe("confirmed");
    expect(job?.txid).not.toBeNull();

    const ledgerRows = stack.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.refType, "payout"))
      .all();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.deltaMicrousdc).toBe(-15_000);
    expect(ledgerRows[0]?.account).toBe("treasury");

    const events = stack.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, "payout_confirmed"))
      .all();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.payloadJson ?? "{}")).toMatchObject({
      gameId: "gm_pay",
      amountMicroUsdc: 15_000,
    });

    expect(await treasuryUsdc(stack)).toBe(INITIAL - 15_000);
  });
});

describe("payout executor — crash matrix (release gate: prepare/submit boundary)", () => {
  it("never double-pays when the broadcast landed but 'submitted' was not recorded", async () => {
    const shared = createMockRailState({ usdcMicroUsdc: INITIAL });
    const stack = makeStack({}, shared);
    seedGame(stack.db, stack.now(), "gm_crash");
    seedJob(stack.db, stack.now(), {
      id: "pj_c",
      gameId: "gm_crash",
      recipient: "alice",
      amount: 20_000,
    });

    // Broadcast reaches the chain (applied) but the node reply is ambiguous.
    // Recovery owns the durable txid immediately and can confirm it safely.
    stack.rail.control.queueSubmitPrepared({
      ok: false,
      reason: "unavailable",
      applied: true,
    });
    await drain(stack);
    const batchAfterCrash = stack.db.select().from(schema.payoutBatches).get();
    expect(batchAfterCrash?.status).toBe("confirmed");
    // The chain already moved the money exactly once.
    expect(await treasuryUsdc(stack)).toBe(INITIAL - 20_000);

    // Restart: the confirmed persisted bytes remain idempotent.
    stack.reboot();
    await drain(stack);

    const job = stack.db.select().from(schema.payoutJobs).get();
    expect(job?.status).toBe("confirmed");
    const batch = stack.db.select().from(schema.payoutBatches).get();
    expect(batch?.status).toBe("confirmed");
    // Recovery never produces a second debit.
    expect(await treasuryUsdc(stack)).toBe(INITIAL - 20_000);
    expect(batch?.payloadB64).toBe(batchAfterCrash?.payloadB64);
  });

  it("waits out an ambiguous unapplied broadcast before creating one replacement", async () => {
    const shared = createMockRailState({ usdcMicroUsdc: INITIAL });
    const stack = makeStack({}, shared);
    seedGame(stack.db, stack.now(), "gm_crash2");
    seedJob(stack.db, stack.now(), {
      id: "pj_c2",
      gameId: "gm_crash2",
      recipient: "bob",
      amount: 12_000,
    });

    stack.rail.control.queueSubmitPrepared({
      ok: false,
      reason: "unavailable",
      applied: false,
    });
    await drain(stack);
    expect(await treasuryUsdc(stack)).toBe(INITIAL); // nothing left the chain yet
    const submitted = stack.db.select().from(schema.payoutBatches).get();
    expect(submitted?.status).toBe("submitted");

    stack.reboot();
    await drain(stack);
    expect(stack.db.select().from(schema.payoutJobs).get()?.status).toBe(
      "submitted",
    );
    expect(await treasuryUsdc(stack)).toBe(INITIAL);

    stack.setNow(stack.now() + 2_001);
    await drain(stack);
    expect(stack.db.select().from(schema.payoutJobs).get()?.status).toBe(
      "pending",
    );
    stack.setNow(stack.now() + 1_001);
    await drain(stack);

    expect(stack.db.select().from(schema.payoutJobs).get()?.status).toBe(
      "confirmed",
    );
    expect(await treasuryUsdc(stack)).toBe(INITIAL - 12_000);
  });
});

describe("payout executor — retries and failure (F7 step 4)", () => {
  it("retries a rejected submit with backoff and gives up as failed but visible", async () => {
    const stack = makeStack({ PAYOUT_MAX_ATTEMPTS: 3 });
    seedGame(stack.db, stack.now(), "gm_rej");
    seedJob(stack.db, stack.now(), {
      id: "pj_r",
      gameId: "gm_rej",
      recipient: "carol",
      amount: 9_000,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      stack.rail.control.queueSubmitPrepared({ ok: false, reason: "rejected" });
      await drain(stack);
      stack.setNow(stack.now() + 60_000);
    }

    const job = stack.db.select().from(schema.payoutJobs).get();
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBeGreaterThanOrEqual(3);
    // Failure is a visible terminal state, not a silent drop.
    expect(await treasuryUsdc(stack)).toBe(INITIAL);
  });
});

describe("payout executor — batch cap (F7, rail 17-cap never hit)", () => {
  it("splits more than PAYOUT_BATCH_MAX due jobs into multiple batches", async () => {
    const stack = makeStack({ PAYOUT_BATCH_MAX: 3 });
    seedGame(stack.db, stack.now(), "gm_batch");
    for (let i = 0; i < 7; i += 1) {
      seedJob(stack.db, stack.now(), {
        id: `pj_b${i}`,
        gameId: "gm_batch",
        recipient: `r${i}`,
        amount: 1_000,
      });
    }

    await drain(stack);

    const batches = stack.db.select().from(schema.payoutBatches).all();
    expect(batches.length).toBe(3); // ceil(7 / 3)
    const jobs = stack.db.select().from(schema.payoutJobs).all();
    expect(jobs.every((j) => j.status === "confirmed")).toBe(true);
    // Each batch respects the configured cap (well under the rail's 16 hard cap).
    for (const batch of batches) {
      const count = stack.db
        .select()
        .from(schema.payoutJobs)
        .where(eq(schema.payoutJobs.batchId, batch.id))
        .all().length;
      expect(count).toBeLessThanOrEqual(3);
    }
  });
});

describe("payout executor — boot resume (F1 step 6)", () => {
  it("payout_retry_and_restart_reuse_durable_prepared_bytes", async () => {
    const shared = createMockRailState({ usdcMicroUsdc: INITIAL });
    const stack = makeStack({}, shared);
    seedGame(stack.db, stack.now(), "gm_boot");
    seedJob(stack.db, stack.now(), {
      id: "pj_boot",
      gameId: "gm_boot",
      recipient: "dave",
      amount: 7_000,
    });

    // The broadcast lands (chain debited) but the confirmation query is
    // unavailable, so the batch is left 'submitted' — the pre-crash state F1
    // step 6 must recover.
    stack.rail.control.failQueries(["status", "note"]);
    await drain(stack);
    const submitted = stack.db.select().from(schema.payoutBatches).get();
    expect(submitted?.status).toBe("submitted");
    expect(await treasuryUsdc(stack)).toBe(INITIAL - 7_000);

    // Fresh boot with a healthy chain: the submitted txids are queried.
    stack.reboot();
    await drain(stack);

    expect(stack.db.select().from(schema.payoutJobs).get()?.status).toBe(
      "confirmed",
    );
    const ledger = stack.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.refType, "payout"))
      .all();
    expect(ledger).toHaveLength(1);
    expect(await treasuryUsdc(stack)).toBe(INITIAL - 7_000);
  });
});

describe("payout executor — end-to-end echo memory (F7)", () => {
  it("treasury echo equals initial + settles − payouts after a resolved game", async () => {
    const stack = makeStack();
    // Two staked human moves settle into the treasury (mock echo memory bumps).
    const stakes = [10_000, 10_000];
    let settled = 0;
    for (const [i, amount] of stakes.entries()) {
      const challenge = stack.rail.buildPaymentChallenge({
        amountMicroUsdc: amount,
        resource: "https://osc.example/api/v1/moves",
      });
      const header = buildMockHeader({
        challenge,
        from: `payer_${i}`,
        nonce: `settle_${i}`,
      });
      const result = await stack.rail.settle(header, challenge.required);
      if (result.ok) settled += amount;
    }
    expect(settled).toBe(20_000);

    // Seed a resolvable staked game (white wins), then resolve + pay out.
    stack.db
      .insert(schema.games)
      .values({
        id: "gm_e2e",
        name: "e2e",
        status: "finished",
        fen: STARTING_FEN,
        rulesJson: RULES_JSON,
        lastPlyAt: stack.now(),
        createdAt: stack.now(),
        result: "white",
        termination: "checkmate",
        finishedAt: stack.now(),
      })
      .run();
    for (const [i, side] of (["white", "black"] as const).entries()) {
      stack.db
        .insert(schema.players)
        .values({
          address: `e2e_${side}`,
          kind: "human",
          nickname: `e2e_${side}`,
          createdAt: stack.now(),
        })
        .run();
      stack.db
        .insert(schema.claims)
        .values({
          id: `clm_e2e_${i}`,
          gameId: "gm_e2e",
          player: `e2e_${side}`,
          side,
          demo: false,
          stakeMicrousdc: 10_000,
          status: "moved",
          createdAt: stack.now(),
          deadline: stack.now() + 1_000,
          movedAt: stack.now(),
          movedPly: i + 1,
        })
        .run();
      stack.db
        .insert(schema.stakeEntries)
        .values({
          id: `se_e2e_${i}`,
          gameId: "gm_e2e",
          claimId: `clm_e2e_${i}`,
          player: `e2e_${side}`,
          side,
          kind: "human",
          amount: 10_000,
          payTxid: `settle_${i}`,
          ply: i + 1,
          createdAt: stack.now(),
        })
        .run();
    }
    // Clear resolved marker so resolution runs.
    stack.db
      .update(schema.games)
      .set({ resolvedAt: null })
      .where(eq(schema.games.id, "gm_e2e"))
      .run();
    await stack.coordinator.dispatch({
      type: "GameFinished",
      payload: { gameId: "gm_e2e" },
      refIds: ["gm_e2e"],
    });

    await drain(stack);

    const paidOut = stack.db
      .select()
      .from(schema.payoutJobs)
      .where(inArray(schema.payoutJobs.status, ["confirmed"]))
      .all()
      .reduce((sum, j) => sum + j.amount, 0);
    expect(paidOut).toBeGreaterThan(0);
    expect(await treasuryUsdc(stack)).toBe(INITIAL + settled - paidOut);
  });
});
