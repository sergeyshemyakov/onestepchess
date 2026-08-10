import { createMockRail } from "@onestepchess/rail-mock";
import algosdk from "algosdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminReadCache } from "../admin/cache.js";
import { adminBonuses, adminOverview } from "../admin/read-models.js";
import { initializeSystemState } from "../boot.js";
import { serverConfigSchema } from "../config.js";
import { Coordinator } from "../coordinator/queue.js";
import { CoordinatorViews } from "../coordinator/views.js";
import { type OpenedDatabase, openDatabase, schema } from "../db/open.js";
import { createLogger } from "../logger.js";
import { OperationalAlerts } from "../operations/alerts.js";
import {
  OperationalState,
  registerOperationalCommands,
  runReconciliation,
} from "../operations/reconciliation.js";
import {
  type FundingExecutorDeps,
  hasAlgoFundingCapacity,
  rearmBonusFunding,
  registerFundingCommands,
  runFundingExecutor,
} from "./funding.js";
import { registerBonusCommands } from "./lifecycle.js";

const INITIAL_USDC = 10_000_000;
const INITIAL_ALGO = 10_000_000;
const INITIAL_BONUS_USDC = 5_000_000;
const INITIAL_BONUS_ALGO = 5_000_000;
const databases: OpenedDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
});

function setup(overrides: Record<string, unknown> = {}) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  let now = 1_000_000;
  let config = serverConfigSchema.parse({
    BONUS_ALGO_MICRO: 250_000,
    BONUS_USDC_MICRO: 200_000,
    BONUS_MAX_ATTEMPTS: 3,
    PAYMENT_RECOVERY_TIMEOUT_SECONDS: 2,
    TREASURY_MIN_ALGO_MICRO: 1_000_000,
    ...overrides,
  });
  const rail = createMockRail({
    initialTreasury: {
      usdcMicroUsdc: INITIAL_USDC,
      algoMicroAlgo: INITIAL_ALGO,
    },
    initialBonus: {
      usdcMicroUsdc: INITIAL_BONUS_USDC,
      algoMicroAlgo: INITIAL_BONUS_ALGO,
    },
  });
  const logger = createLogger({ level: "silent" });
  initializeSystemState({
    db: database.db,
    railKind: "mock",
    config,
    treasuryAddress: rail.treasuryAddress,
    banner: undefined,
    now,
    logger,
  });
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger,
    now: () => now,
  });
  const cache = new AdminReadCache(
    () => now,
    () => 60,
  );
  const deliveries = vi.fn(async () => new Response(null, { status: 204 }));
  const alerts = new OperationalAlerts({
    url: "https://alerts.example",
    dedupeSeconds: () => config.ALERT_DEDUPE_SECONDS,
    now: () => now,
    transport: deliveries,
    logger,
  });
  const deps: FundingExecutorDeps = {
    coordinator,
    db: database.db,
    rail,
    config: () => config,
    now: () => now,
    logger,
    alerts,
    cache,
  };
  registerBonusCommands({
    coordinator,
    db: database.db,
    config: () => config,
    cache,
  });
  registerFundingCommands(deps);
  const state = new OperationalState();
  const reconciliation = {
    coordinator,
    db: database.db,
    rail,
    config: () => config,
    now: () => now,
    alerts,
    state,
  };
  registerOperationalCommands(reconciliation);
  return {
    database,
    coordinator,
    rail,
    deps,
    cache,
    alerts,
    deliveries,
    state,
    reconciliation,
    config: () => config,
    now: () => now,
    setNow(value: number) {
      now = value;
    },
    setConfig(values: Record<string, unknown>) {
      config = serverConfigSchema.parse({ ...config, ...values });
    },
  };
}

type Stack = ReturnType<typeof setup>;

function seedBonus(
  stack: Stack,
  account: algosdk.Account,
  status: "claimed" | "opted_in" | "funded" = "claimed",
  extra: Partial<typeof schema.players.$inferInsert> = {},
): void {
  const address = account.addr.toString();
  stack.database.db
    .insert(schema.players)
    .values({
      address,
      kind: "human",
      nickname: address.slice(0, 8),
      createdAt: stack.now(),
      ...extra,
    })
    .run();
  stack.database.db
    .insert(schema.bonuses)
    .values({
      player: address,
      status,
      algoAmount: stack.config().BONUS_ALGO_MICRO,
      usdcAmount: stack.config().BONUS_USDC_MICRO,
      claimIp: "203.0.113.20",
      claimedAt: stack.now(),
      ...(status === "claimed" ? {} : { optedInAt: stack.now() }),
      ...(status === "funded"
        ? { fundedAt: stack.now(), usdcTxid: "already-funded" }
        : {}),
    })
    .run();
}

function insertPendingJob(
  stack: Stack,
  account: algosdk.Account,
  leg: "algo" | "usdc",
  id = `fj_${leg}_${account.addr.toString().slice(0, 8)}`,
): string {
  stack.database.db
    .insert(schema.fundingJobs)
    .values({
      id,
      player: account.addr.toString(),
      leg,
      amount:
        leg === "algo"
          ? stack.config().BONUS_ALGO_MICRO
          : stack.config().BONUS_USDC_MICRO,
      status: "pending",
      createdAt: stack.now(),
      updatedAt: stack.now(),
    })
    .run();
  return id;
}

async function insertPreparedJob(
  stack: Stack,
  account: algosdk.Account,
  leg: "algo" | "usdc",
  status: "prepared" | "submitted",
  id = `fj_${leg}_${status}_${account.addr.toString().slice(0, 8)}`,
) {
  const amount =
    leg === "algo"
      ? stack.config().BONUS_ALGO_MICRO
      : stack.config().BONUS_USDC_MICRO;
  const prepared = await stack.rail.prepareFunding({
    player: account.addr.toString(),
    leg,
    amount,
  });
  if (status === "submitted") {
    const result = await stack.rail.submitPrepared(prepared);
    if (!result.ok) throw new Error("fixture submission failed");
  }
  stack.database.db
    .insert(schema.fundingJobs)
    .values({
      id,
      player: account.addr.toString(),
      leg,
      amount,
      status,
      payloadB64: prepared.payloadB64,
      txid: prepared.txid,
      lastValidRound: prepared.lastValidRound,
      createdAt: stack.now(),
      updatedAt: stack.now(),
    })
    .run();
  return { id, prepared };
}

function pause(stack: Stack, ...causes: string[]): void {
  stack.database.db
    .update(schema.systemState)
    .set({ pauseCausesJson: JSON.stringify(causes) })
    .run();
}

function seedStake(stack: Stack, account: algosdk.Account): void {
  const address = account.addr.toString();
  stack.database.db
    .insert(schema.games)
    .values({
      id: "gm_admin_bonus",
      name: "admin-bonus-game",
      status: "finished",
      fen: "fen",
      rulesJson: "{}",
      result: "white",
      termination: "checkmate",
      lastPlyAt: stack.now(),
      createdAt: stack.now(),
      finishedAt: stack.now(),
      resolvedAt: stack.now(),
    })
    .run();
  stack.database.db
    .insert(schema.claims)
    .values({
      id: "clm_admin_bonus",
      gameId: "gm_admin_bonus",
      player: address,
      side: "white",
      demo: false,
      stakeMicrousdc: 10_000,
      status: "moved",
      createdAt: stack.now(),
      deadline: stack.now() + 1,
      movedAt: stack.now(),
      movedPly: 1,
      moveUci: "e2e4",
      moveSan: "e4",
      fenBefore: "before",
      fenAfter: "after",
    })
    .run();
  stack.database.db
    .insert(schema.stakeEntries)
    .values({
      id: "se_admin_bonus",
      gameId: "gm_admin_bonus",
      claimId: "clm_admin_bonus",
      player: address,
      side: "white",
      kind: "human",
      amount: 10_000,
      payTxid: "stake-txid",
      ply: 1,
      payoutAmount: 20_000,
      createdAt: stack.now(),
    })
    .run();
}

describe("Release 4 recoverable starter-stake funding (#99)", () => {
  it("algo_funding_guard_preserves_the_floor_after_the_flat_transaction_fee", () => {
    expect(hasAlgoFundingCapacity(1_250_999, 250_000, 1_000_000)).toBe(false);
    expect(hasAlgoFundingCapacity(1_251_000, 250_000, 1_000_000)).toBe(true);
  });

  it("bonus_funding_skips_algo_for_opted_in_or_half_algo_accounts_and_never_creates_a_phantom_job", async () => {
    const stack = setup();
    const opted = algosdk.generateAccount();
    const exact = algosdk.generateAccount();
    const below = algosdk.generateAccount();
    for (const account of [opted, exact, below]) seedBonus(stack, account);
    stack.rail.control.setAccountInfo(opted.addr.toString(), {
      optedInUsdc: true,
      spendableAlgoMicro: 0,
    });
    stack.rail.control.setAccountInfo(exact.addr.toString(), {
      optedInUsdc: false,
    });
    stack.rail.control.setBalances(exact.addr.toString(), {
      algoMicroAlgo: 500_000,
    });
    stack.rail.control.setAccountInfo(below.addr.toString(), {
      optedInUsdc: false,
    });
    stack.rail.control.setBalances(below.addr.toString(), {
      algoMicroAlgo: 499_999,
    });

    await runFundingExecutor(stack.deps);

    const jobs = stack.database.db.select().from(schema.fundingJobs).all();
    expect(
      jobs.filter(
        (job) => job.player === opted.addr.toString() && job.leg === "algo",
      ),
    ).toHaveLength(0);
    expect(
      jobs.filter((job) => job.player === exact.addr.toString()),
    ).toHaveLength(0);
    expect(
      jobs.filter(
        (job) => job.player === below.addr.toString() && job.leg === "algo",
      ),
    ).toHaveLength(1);
  });

  it("fresh_wallet_claim_receives_the_ALGO_leg_before_USDC_opt_in", async () => {
    const stack = setup();
    const fresh = algosdk.generateAccount();
    seedBonus(stack, fresh);
    stack.rail.control.setAccountInfo(fresh.addr.toString(), {
      optedInUsdc: false,
    });
    stack.rail.control.setBalances(fresh.addr.toString(), {
      usdcMicroUsdc: 0,
      algoMicroAlgo: 0,
    });

    await runFundingExecutor(stack.deps);

    expect(
      stack.database.db
        .select()
        .from(schema.fundingJobs)
        .where(eq(schema.fundingJobs.player, fresh.addr.toString()))
        .get(),
    ).toMatchObject({ leg: "algo", status: "confirmed" });
  });

  it("bonus_funding_persists_signed_bytes_txid_and_validity_before_each_broadcast", async () => {
    const stack = setup();
    const algo = algosdk.generateAccount();
    const usdc = algosdk.generateAccount();
    seedBonus(stack, algo, "claimed");
    seedBonus(stack, usdc, "opted_in");
    stack.rail.control.setAccountInfo(algo.addr.toString(), {
      optedInUsdc: false,
      spendableAlgoMicro: 0,
    });
    const original = stack.rail.submitPrepared.bind(stack.rail);
    const observed: string[] = [];
    vi.spyOn(stack.rail, "submitPrepared").mockImplementation(
      async (prepared) => {
        const row = stack.database.db
          .select()
          .from(schema.fundingJobs)
          .where(
            eq(
              schema.fundingJobs.txid,
              prepared.kind === "funding" ? prepared.txid : "",
            ),
          )
          .get();
        expect(row).toMatchObject({
          status: "prepared",
          payloadB64: prepared.payloadB64,
          txid: prepared.kind === "funding" ? prepared.txid : undefined,
          lastValidRound: prepared.lastValidRound,
        });
        observed.push(row?.leg ?? "missing");
        return original(prepared);
      },
    );

    await runFundingExecutor(stack.deps);
    expect(observed.sort()).toEqual(["algo", "usdc"]);
  });

  it("bonus_funding_crash_matrix_never_double_sends_or_loses_a_leg", async () => {
    const applied = setup();
    const account = algosdk.generateAccount();
    seedBonus(applied, account, "opted_in");
    applied.rail.control.queueSubmitPrepared({
      ok: false,
      reason: "unavailable",
      applied: true,
    });
    applied.rail.control.failQueries(["status", "note"]);
    await runFundingExecutor(applied.deps);
    expect(
      applied.database.db.select().from(schema.fundingJobs).get()?.status,
    ).toBe("submitted");
    applied.rail.control.restoreQueries();
    await runFundingExecutor(applied.deps);
    await runFundingExecutor(applied.deps);
    expect(
      (await applied.rail.getBalances(applied.rail.bonusAddress)).usdcMicroUsdc,
    ).toBe(INITIAL_BONUS_USDC - 200_000);
    expect(
      (await applied.rail.getBalances(applied.rail.treasuryAddress))
        .usdcMicroUsdc,
    ).toBe(INITIAL_USDC);
    expect(
      applied.database.db
        .select()
        .from(schema.ledger)
        .where(eq(schema.ledger.refType, "bonus"))
        .all(),
    ).toHaveLength(1);

    const unapplied = setup();
    const second = algosdk.generateAccount();
    seedBonus(unapplied, second, "opted_in");
    unapplied.rail.control.queueSubmitPrepared({
      ok: false,
      reason: "unavailable",
      applied: false,
    });
    unapplied.rail.control.failQueries(["status", "note"]);
    await runFundingExecutor(unapplied.deps);
    unapplied.rail.control.restoreQueries();
    unapplied.setNow(unapplied.now() + 2_001);
    await runFundingExecutor(unapplied.deps);
    unapplied.setNow(unapplied.now() + 1_001);
    await runFundingExecutor(unapplied.deps);
    expect(
      (await unapplied.rail.getBalances(unapplied.rail.bonusAddress))
        .usdcMicroUsdc,
    ).toBe(INITIAL_BONUS_USDC - 200_000);

    const noteFallback = setup();
    const third = algosdk.generateAccount();
    seedBonus(noteFallback, third, "opted_in");
    const prepared = await insertPreparedJob(
      noteFallback,
      third,
      "usdc",
      "prepared",
    );
    noteFallback.database.db
      .update(schema.fundingJobs)
      .set({ status: "submitted" })
      .where(eq(schema.fundingJobs.id, prepared.id))
      .run();
    noteFallback.rail.control.setTxStatus(prepared.prepared.txid, {
      status: "not_found",
      currentRound: 9_999,
    });
    noteFallback.rail.control.setFundingNoteResult(
      third.addr.toString(),
      "usdc",
      {
        txid: prepared.prepared.txid,
        confirmedRound: 1_001,
      },
    );
    await runFundingExecutor(noteFallback.deps);
    expect(
      noteFallback.database.db.select().from(schema.bonuses).get()?.status,
    ).toBe("funded");
  });

  it("bonus_account_guards_defer_discretionary_work_without_stranding_submitted_obligations", async () => {
    const stack = setup();
    const pending = algosdk.generateAccount();
    seedBonus(stack, pending, "claimed");
    stack.rail.control.setAccountInfo(pending.addr.toString(), {
      optedInUsdc: false,
      spendableAlgoMicro: 0,
    });
    pause(stack, "manual", "reconciliation");
    await runFundingExecutor(stack.deps);
    await runFundingExecutor(stack.deps);
    expect(
      stack.database.db.select().from(schema.fundingJobs).get()?.status,
    ).toBe("pending");
    await Promise.resolve();
    expect(stack.deliveries).toHaveBeenCalledTimes(1);

    pause(stack);
    stack.rail.control.setBalances(stack.rail.bonusAddress, {
      algoMicroAlgo: stack.config().BONUS_MIN_ALGO_MICRO + 249_999,
    });
    await runFundingExecutor(stack.deps);
    expect(
      stack.database.db.select().from(schema.fundingJobs).get()?.status,
    ).toBe("pending");

    const submittedAccount = algosdk.generateAccount();
    seedBonus(stack, submittedAccount, "opted_in");
    const submitted = await insertPreparedJob(
      stack,
      submittedAccount,
      "usdc",
      "submitted",
    );
    pause(stack, "facilitator");
    await runFundingExecutor(stack.deps);
    expect(
      stack.database.db
        .select()
        .from(schema.fundingJobs)
        .where(eq(schema.fundingJobs.id, submitted.id))
        .get()?.status,
    ).toBe("confirmed");

    const shortfall = algosdk.generateAccount();
    seedBonus(stack, shortfall, "opted_in");
    pause(stack);
    stack.rail.control.setBalances(stack.rail.bonusAddress, {
      usdcMicroUsdc: 100_000,
      algoMicroAlgo: INITIAL_BONUS_ALGO,
    });
    await runFundingExecutor(stack.deps);
    expect(
      stack.database.db
        .select()
        .from(schema.fundingJobs)
        .where(eq(schema.fundingJobs.player, shortfall.addr.toString()))
        .get()?.status,
    ).toBe("pending");
  });

  it("confirmed_bonus_usdc_updates_status_ledger_and_sse_exactly_once", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    seedBonus(stack, account, "opted_in", { points: 17 });
    await runFundingExecutor(stack.deps);
    await runFundingExecutor(stack.deps);
    expect(stack.database.db.select().from(schema.bonuses).get()).toMatchObject(
      {
        status: "funded",
        usdcTxid: expect.any(String),
      },
    );
    const bonusEntries = stack.database.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.refType, "bonus"))
      .all();
    expect(bonusEntries).toHaveLength(1);
    // Bonus spend is booked against its own account so the treasury book
    // keeps mirroring the treasury chain balance.
    expect(bonusEntries[0]).toMatchObject({
      account: "bonus",
      deltaMicrousdc: -200_000,
    });
    expect(
      stack.database.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.type, "bonus_updated"))
        .all(),
    ).toHaveLength(1);
    expect(stack.database.db.select().from(schema.players).get()?.points).toBe(
      17,
    );
    expect(
      stack.database.db.select().from(schema.payoutJobs).all(),
    ).toHaveLength(0);
  });

  it("reconciliation_excludes_bonus_funding_from_treasury_drift_and_monitors_the_bonus_account", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    const account = algosdk.generateAccount();
    seedBonus(stack, account, "opted_in");
    const job = await insertPreparedJob(stack, account, "usdc", "prepared");
    const preparedReport = await runReconciliation(
      stack.reconciliation,
      "admin",
    );
    expect(preparedReport.outboundToleranceMicroUsdc).toBe(0);
    expect(preparedReport.ok).toBe(true);
    expect(preparedReport.bonusUsdcMicroUsdc).toBe(INITIAL_BONUS_USDC);
    expect(preparedReport.bonusLow).toBe(false);

    // The submitted USDC leg leaves the bonus account, so the treasury book
    // needs no bonus tolerance and stays balanced without one.
    await stack.rail.submitPrepared(job.prepared);
    stack.database.db
      .update(schema.fundingJobs)
      .set({ status: "submitted" })
      .where(eq(schema.fundingJobs.id, job.id))
      .run();
    const submittedReport = await runReconciliation(
      stack.reconciliation,
      "admin",
    );
    expect(submittedReport.outboundToleranceMicroUsdc).toBe(0);
    expect(submittedReport.ok).toBe(true);
    expect(submittedReport.bonusUsdcMicroUsdc).toBe(
      INITIAL_BONUS_USDC - 200_000,
    );

    stack.rail.control.setBalances(stack.rail.bonusAddress, {
      usdcMicroUsdc: 100_000,
      algoMicroAlgo: INITIAL_BONUS_ALGO,
    });
    const lowReport = await runReconciliation(stack.reconciliation, "admin");
    expect(lowReport.bonusLow).toBe(true);
    expect(lowReport.ok).toBe(true);
    expect(
      JSON.parse(
        stack.database.db.select().from(schema.systemState).get()
          ?.pauseCausesJson ?? "[]",
      ),
    ).toEqual([]);
    await Promise.resolve();
    const deliveredBodies = (
      stack.deliveries.mock.calls as unknown as [string, { body: string }][]
    ).map((call) => call[1]?.body ?? "");
    expect(
      deliveredBodies.some((body) => body.includes("bonus_account_low")),
    ).toBe(true);

    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: INITIAL_USDC - 300_001,
    });
    const drift = await runReconciliation(stack.reconciliation, "admin");
    expect(drift.ok).toBe(false);
    expect(
      JSON.parse(
        stack.database.db.select().from(schema.systemState).get()
          ?.pauseCausesJson ?? "[]",
      ),
    ).toContain("reconciliation");
  });

  it("bonus_attempt_exhaustion_stays_visible_and_admin_retry_rearms_only_after_safe_recovery", async () => {
    const stack = setup({ BONUS_MAX_ATTEMPTS: 1 });
    const account = algosdk.generateAccount();
    seedBonus(stack, account, "opted_in");
    stack.rail.control.queueSubmitPrepared({
      ok: false,
      reason: "rejected",
      detail: "definite rejection",
    });
    await runFundingExecutor(stack.deps);
    const failed = stack.database.db.select().from(schema.fundingJobs).get();
    expect(failed).toMatchObject({
      status: "failed",
      attempts: 1,
      payloadB64: expect.any(String),
      txid: expect.any(String),
      lastValidRound: expect.any(Number),
    });
    expect(
      await rearmBonusFunding(stack.deps, account.addr.toString(), "admin"),
    ).toEqual({ status: "unsafe" });
    stack.setNow(stack.now() + 2_001);
    expect(
      await rearmBonusFunding(stack.deps, account.addr.toString(), "admin"),
    ).toEqual({ status: "pending", jobs: 1 });
    expect(
      stack.database.db.select().from(schema.fundingJobs).get(),
    ).toMatchObject({
      status: "pending",
      attempts: 0,
      payloadB64: null,
    });
    expect(
      stack.database.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "bonus.retry"))
        .all(),
    ).toHaveLength(1);
  });

  it("admin_bonuses_and_overview_match_funding_ground_truth", async () => {
    const stack = setup();
    const referrer = algosdk.generateAccount();
    stack.database.db
      .insert(schema.players)
      .values({
        address: referrer.addr.toString(),
        kind: "human",
        nickname: "referrer",
        createdAt: stack.now(),
      })
      .run();
    const account = algosdk.generateAccount();
    seedBonus(stack, account, "opted_in", {
      points: 42,
      referredBy: referrer.addr.toString(),
    });
    seedStake(stack, account);
    const before = await stack.cache.get("bonuses:1", () =>
      adminBonuses(
        {
          db: stack.database.db,
          rail: stack.rail,
          views: new CoordinatorViews(),
          config: stack.config,
          baseConfig: stack.config(),
          state: stack.state,
          clientCount: () => 0,
          now: stack.now,
        },
        1,
      ),
    );
    await runFundingExecutor(stack.deps);
    const readDeps = {
      db: stack.database.db,
      rail: stack.rail,
      views: new CoordinatorViews(),
      config: stack.config,
      baseConfig: stack.config(),
      state: stack.state,
      clientCount: () => 0,
      now: stack.now,
    };
    const bonuses = adminBonuses(readDeps, 1);
    expect(bonuses).toMatchObject({
      todayClaimed: 1,
      dailyCap: stack.config().BONUS_DAILY_CAP,
      totalClaimed: 1,
      totalAlgoMicro: 0,
      totalUsdcMicro: 200_000,
      page: 1,
      pageCount: 1,
      total: 1,
      items: [
        {
          address: account.addr.toString(),
          nickname: account.addr.toString().slice(0, 8),
          status: "funded",
          claimIp: "203.0.113.20",
          claimedAt: new Date(stack.now()).toISOString(),
          fundedAt: new Date(stack.now()).toISOString(),
          algoTxid: null,
          lifetimeStakedMoves: 1,
          points: 42,
          referredBy: referrer.addr.toString(),
          usdcTxid: expect.any(String),
        },
      ],
    });
    const after = await stack.cache.get("bonuses:1", () => bonuses);
    expect(after.etag).not.toBe(before.etag);
    const overview = await adminOverview(readDeps);
    expect(overview.funding).toEqual({
      pending: 0,
      prepared: 0,
      submitted: 0,
      failed: 0,
    });
    expect(JSON.stringify({ bonuses, overview })).not.toMatch(
      /mnemonic|payloadB64|signed/i,
    );
  });

  it("boot_recovers_all_bonus_and_funding_states_before_new_submissions", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    const pending = algosdk.generateAccount();
    const prepared = algosdk.generateAccount();
    const submitted = algosdk.generateAccount();
    const fresh = algosdk.generateAccount();
    const funded = algosdk.generateAccount();
    for (const account of [pending, prepared, submitted, fresh]) {
      seedBonus(stack, account, "opted_in");
    }
    seedBonus(stack, funded, "funded");
    insertPendingJob(stack, pending, "usdc");
    const preparedJob = await insertPreparedJob(
      stack,
      prepared,
      "usdc",
      "prepared",
    );
    const submittedJob = await insertPreparedJob(
      stack,
      submitted,
      "usdc",
      "submitted",
    );

    const order: string[] = [];
    const originalStatus = stack.rail.getTransactionStatus.bind(stack.rail);
    vi.spyOn(stack.rail, "getTransactionStatus").mockImplementation(
      async (txid) => {
        if (txid === submittedJob.prepared.txid)
          order.push("recover-submitted");
        return originalStatus(txid);
      },
    );
    const originalSubmit = stack.rail.submitPrepared.bind(stack.rail);
    vi.spyOn(stack.rail, "submitPrepared").mockImplementation(async (value) => {
      if (
        value.kind === "funding" &&
        value.txid === preparedJob.prepared.txid
      ) {
        order.push("recover-prepared");
      }
      return originalSubmit(value);
    });
    const originalPrepare = stack.rail.prepareFunding.bind(stack.rail);
    vi.spyOn(stack.rail, "prepareFunding").mockImplementation(async (value) => {
      order.push(`prepare-new:${value.player}`);
      return originalPrepare(value);
    });

    await runFundingExecutor(stack.deps);
    expect(order.slice(0, 2)).toEqual([
      "recover-submitted",
      "recover-prepared",
    ]);
    expect(
      stack.database.db
        .select()
        .from(schema.fundingJobs)
        .all()
        .every((job) => job.status === "confirmed"),
    ).toBe(true);
    expect(
      stack.database.db
        .select()
        .from(schema.bonuses)
        .all()
        .every((bonus) => bonus.status === "funded"),
    ).toBe(true);
    expect(
      stack.database.db.select().from(schema.fundingJobs).all(),
    ).toHaveLength(4);
    const reconciliation = await runReconciliation(
      stack.reconciliation,
      "admin",
    );
    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.driftMicroUsdc).toBe(0);
  });
});
