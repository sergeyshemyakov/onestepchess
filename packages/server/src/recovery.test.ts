import { createRng } from "@onestepchess/core";
import { createMockRail } from "@onestepchess/rail-mock";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { serverConfigSchema } from "./config.js";
import { ChessAdapterRegistry } from "./coordinator/chess-registry.js";
import {
  type ClaimRecord,
  registerClaimCommands,
} from "./coordinator/claims.js";
import { registerLifecycle } from "./coordinator/lifecycle.js";
import { Coordinator } from "./coordinator/queue.js";
import { registerResolution } from "./coordinator/resolution.js";
import { TimerService } from "./coordinator/timers.js";
import { CoordinatorViews } from "./coordinator/views.js";
import { type OpenedDatabase, openDatabase, schema } from "./db/open.js";
import { createLogger } from "./logger.js";
import {
  completeBootRecovery,
  recoverSettlingIntents,
  recoverUnresolvedTerminalGames,
} from "./recovery.js";

const databases: OpenedDatabase[] = [];

function setup() {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  const config = serverConfigSchema.parse({
    GAME_POOL_TARGET: 1,
    PAYMENT_RECOVERY_TIMEOUT_SECONDS: 2,
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
  const timers = new TimerService({ now: () => now, onFire: () => {} });
  const registry = new ChessAdapterRegistry(4);
  const lifecycle = registerLifecycle({
    coordinator,
    db: database.db,
    views,
    timers,
    registry,
    config: () => config,
    rng: createRng(2),
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
    rng: createRng(5),
  };
  registerClaimCommands(deps);
  registerResolution({
    coordinator,
    db: database.db,
    logger: createLogger({ level: "silent" }),
  });
  return {
    ...deps,
    database,
    setNow: (value: number) => {
      now = value;
    },
  };
}

async function settlingIntent(stack: ReturnType<typeof setup>) {
  stack.db
    .insert(schema.players)
    .values({
      address: "alice",
      kind: "human",
      nickname: "alice",
      createdAt: stack.now(),
    })
    .run();
  await stack.coordinator.dispatch({ type: "PoolTick", payload: {} });
  const requested = await stack.coordinator.dispatch<
    { player: string; kind: "human"; demo: false },
    { claim: ClaimRecord | null }
  >({
    type: "ClaimRequested",
    payload: { player: "alice", kind: "human", demo: false },
    claimClass: "human",
  });
  if (requested.kind !== "ok" || requested.result.claim === null)
    throw new Error("claim unavailable");
  const claim = requested.result.claim;
  await stack.coordinator.dispatch({
    type: "PaymentIntentOpened",
    payload: {
      claimId: claim.id,
      player: "alice",
      move: { uci: "e2e4", san: "e4" },
      clientTxid: "mockpay_recovery",
      amount: claim.stakeMicrousdc,
      lastValidRound: null,
    },
  });
  await stack.coordinator.dispatch({
    type: "IntentMarkedSettling",
    payload: { clientTxid: "mockpay_recovery" },
  });
  return claim;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

describe("paid-move boot recovery (F1)", () => {
  it("schedules a fresh unknown intent and fails it at the recovery boundary", async () => {
    const stack = setup();
    const claim = await settlingIntent(stack);
    stack.db
      .update(schema.claims)
      .set({ deadline: stack.now() })
      .where(eq(schema.claims.id, claim.id))
      .run();

    expect(await recoverSettlingIntents(stack)).toMatchObject({
      nextRecoveryAt: stack.now() + 1_000,
    });
    expect(
      stack.db
        .select({ status: schema.claims.status })
        .from(schema.claims)
        .where(eq(schema.claims.id, claim.id))
        .get(),
    ).toEqual({ status: "open" });

    stack.setNow(stack.now() + 2_000);
    expect(await recoverSettlingIntents(stack)).toMatchObject({
      nextRecoveryAt: null,
    });
    expect(
      stack.db
        .select({ status: schema.paymentIntents.status })
        .from(schema.paymentIntents)
        .get(),
    ).toEqual({ status: "failed" });
    expect(
      stack.db
        .select({ status: schema.claims.status })
        .from(schema.claims)
        .where(eq(schema.claims.id, claim.id))
        .get(),
    ).toEqual({ status: "expired" });
  });

  it("boot_recovery_converges_every_settling_and_outgoing_state", async () => {
    const stack = setup();
    const claim = await settlingIntent(stack);
    stack.rail.control.setTxStatus("mockpay_recovery", {
      status: "confirmed",
      confirmedRound: 42,
    });

    expect(await recoverSettlingIntents(stack)).toMatchObject({
      nextRecoveryAt: null,
    });

    expect(
      stack.db
        .select({ status: schema.claims.status })
        .from(schema.claims)
        .where(eq(schema.claims.id, claim.id))
        .get(),
    ).toEqual({ status: "moved" });
    expect(stack.db.select().from(schema.stakeEntries).all()).toHaveLength(1);
    expect(
      stack.db
        .select()
        .from(schema.ledgerBalances)
        .where(eq(schema.ledgerBalances.account, "treasury"))
        .get()?.balanceMicrousdc,
    ).toBe(claim.stakeMicrousdc);
  });

  it("re-enqueues each unresolved terminal game during boot", async () => {
    const stack = setup();
    await stack.coordinator.dispatch({ type: "PoolTick", payload: {} });
    const game = stack.db.select().from(schema.games).get();
    if (game === undefined) throw new Error("game unavailable");
    stack.db
      .update(schema.games)
      .set({
        status: "finished",
        result: "draw",
        termination: "max_plies",
        finishedAt: stack.now(),
      })
      .where(eq(schema.games.id, game.id))
      .run();
    const before = stack.coordinator.stats.commands;

    await recoverUnresolvedTerminalGames(stack);

    expect(stack.coordinator.stats.commands - before).toBe(1);
  });
});

describe("Server robustness F3 — boot gate on error-free recovery (spec 2026-08-26)", () => {
  it("sweep_reports_rail_errors_so_the_boot_gate_can_hold", async () => {
    const stack = setup();
    await settlingIntent(stack);
    stack.rail.control.failQueries();
    const failed = await recoverSettlingIntents(stack);
    expect(failed.errorCount).toBeGreaterThan(0);
    stack.rail.control.restoreQueries();
    stack.rail.control.setTxStatus("mockpay_recovery", {
      status: "confirmed",
      confirmedRound: 42,
    });
    const clean = await recoverSettlingIntents(stack);
    expect(clean.errorCount).toBe(0);
  });

  it("boot_recovery_completes_only_after_an_error_free_sweep", async () => {
    const stack = setup();
    await settlingIntent(stack);
    stack.rail.control.failQueries();
    let retries = 0;
    const completed = await completeBootRecovery(stack, {
      logger: createLogger({ level: "silent" }),
      retryDelayMs: 0,
      sleep: async () => {
        retries += 1;
        if (retries === 3) {
          stack.rail.control.restoreQueries();
          stack.rail.control.setTxStatus("mockpay_recovery", {
            status: "confirmed",
            confirmedRound: 42,
          });
        }
      },
    });
    expect(completed).toBe(true);
    expect(retries).toBeGreaterThanOrEqual(3);
  });

  it("boot_recovery_stops_without_completing_when_asked_to_shut_down", async () => {
    const stack = setup();
    await settlingIntent(stack);
    stack.rail.control.failQueries();
    let passes = 0;
    const completed = await completeBootRecovery(stack, {
      logger: createLogger({ level: "silent" }),
      retryDelayMs: 0,
      sleep: async () => {
        passes += 1;
      },
      shouldContinue: () => passes < 2,
    });
    expect(completed).toBe(false);
  });
});

describe("Server robustness F3 review fix — empty sweep still requires a rail canary", () => {
  it("empty_sweep_does_not_clear_the_gate_while_the_rail_is_down", async () => {
    const stack = setup();
    stack.rail.control.failQueries();
    let passes = 0;
    const stopped = await completeBootRecovery(stack, {
      logger: createLogger({ level: "silent" }),
      retryDelayMs: 0,
      sleep: async () => {
        passes += 1;
      },
      shouldContinue: () => passes < 3,
    });
    expect(stopped).toBe(false);
    stack.rail.control.restoreQueries();
    const completed = await completeBootRecovery(stack, {
      logger: createLogger({ level: "silent" }),
      retryDelayMs: 0,
    });
    expect(completed).toBe(true);
  });
});
