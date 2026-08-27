import { createMockRail } from "@onestepchess/rail-mock";
import algosdk from "algosdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  createFundingScheduler,
  type FundingExecutorDeps,
  FundingGauges,
  hasAlgoFundingCapacity,
  rearmBonusFunding,
  registerFundingCommands,
  reviveExpiredBonus,
  runFundingExecutor,
} from "./funding.js";
import { registerBonusCommands } from "./lifecycle.js";
import { runBonusWatcher } from "./watcher.js";

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
  };
  registerBonusCommands({
    coordinator,
    db: database.db,
    config: () => config,
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
      optInDeadlineAt:
        stack.now() + stack.config().BONUS_OPTIN_EXPIRY_DAYS * 86_400_000,
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

  it("bonus_funding_never_double_sends_when_a_rejected_submit_raced_bytes_that_landed", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    seedBonus(stack, account, "opted_in");
    // Crash-resubmit shape: the bytes landed on a prior broadcast, so the
    // node rejects this POST as a duplicate while the transfer is live.
    stack.rail.control.queueSubmitPrepared({
      ok: false,
      reason: "rejected",
      applied: true,
    });
    await runFundingExecutor(stack.deps);
    stack.setNow(stack.now() + 1_001);
    await runFundingExecutor(stack.deps);
    stack.setNow(stack.now() + 1_001);
    await runFundingExecutor(stack.deps);
    expect(
      (await stack.rail.getBalances(stack.rail.bonusAddress)).usdcMicroUsdc,
    ).toBe(INITIAL_BONUS_USDC - 200_000);
    expect(
      stack.database.db
        .select()
        .from(schema.ledger)
        .where(eq(schema.ledger.refType, "bonus"))
        .all(),
    ).toHaveLength(1);
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
    const before = adminBonuses(readDeps, 1);
    await runFundingExecutor(stack.deps);
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
    // No server-side cache: the funded status shows up on the very next read.
    expect(before.items[0]).toMatchObject({ status: "opted_in" });
    expect(JSON.stringify(bonuses)).not.toBe(JSON.stringify(before));
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

describe("Server robustness F1 — funding executor must not spin (spec 2026-08-26)", () => {
  const DAY_MS = 86_400_000;

  function makeConfirmedAlgoJob(stack: Stack, account: algosdk.Account) {
    return insertPreparedJob(stack, account, "algo", "submitted").then(
      ({ id }) => {
        stack.database.db
          .update(schema.fundingJobs)
          .set({ status: "confirmed", updatedAt: stack.now() })
          .where(eq(schema.fundingJobs.id, id))
          .run();
        return id;
      },
    );
  }

  it("funding_pass_dispatches_nothing_for_an_opted_in_bonus_with_an_existing_usdc_job", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    seedBonus(stack, account, "opted_in");
    const jobId = insertPendingJob(stack, account, "usdc");
    stack.database.db
      .update(schema.fundingJobs)
      .set({ nextAttemptAt: stack.now() + 60_000 })
      .where(eq(schema.fundingJobs.id, jobId))
      .run();
    const dispatch = vi.spyOn(stack.coordinator, "dispatch");
    await runFundingExecutor(stack.deps);
    const types = dispatch.mock.calls.map(([command]) => command.type);
    expect(types).not.toContain("FundingJobCreated");
  });

  it("funding_pass_makes_no_chain_calls_for_a_claimed_bonus_waiting_on_opt_in", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    seedBonus(stack, account, "claimed");
    await makeConfirmedAlgoJob(stack, account);
    const balances = vi.spyOn(stack.rail, "getBalances");
    const accountInfo = vi.spyOn(stack.rail, "getAccountInfo");
    await runFundingExecutor(stack.deps);
    expect(balances).not.toHaveBeenCalled();
    expect(accountInfo).not.toHaveBeenCalled();
  });

  it("pending_job_with_a_future_next_attempt_is_not_prepared_before_it_is_due", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    seedBonus(stack, account, "opted_in");
    const jobId = insertPendingJob(stack, account, "usdc");
    const dueAt = stack.now() + 30_000;
    stack.database.db
      .update(schema.fundingJobs)
      .set({ nextAttemptAt: dueAt })
      .where(eq(schema.fundingJobs.id, jobId))
      .run();
    const prepare = vi.spyOn(stack.rail, "prepareFunding");
    const nextDue = await runFundingExecutor(stack.deps);
    expect(prepare).not.toHaveBeenCalled();
    expect(nextDue).toBe(dueAt);
  });

  it("watcher_expires_a_claimed_bonus_past_its_opt_in_deadline_exactly_once", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const address = account.addr.toString();
    seedBonus(stack, account, "claimed");
    await makeConfirmedAlgoJob(stack, account);
    stack.rail.control.setAccountInfo(address, { optedInUsdc: false });
    stack.setNow(stack.now() + 2 * DAY_MS);
    const emit = vi.spyOn(stack.alerts, "emit");
    const watcherDeps = {
      coordinator: stack.coordinator,
      db: stack.database.db,
      rail: stack.rail,
      now: stack.now,
    };
    await runBonusWatcher(watcherDeps);
    const bonus = stack.database.db
      .select()
      .from(schema.bonuses)
      .where(eq(schema.bonuses.player, address))
      .get();
    expect(bonus?.status).toBe("expired");
    const expiredAlerts = emit.mock.calls.filter(
      ([type]) => type === "bonus_optin_expired",
    );
    expect(expiredAlerts).toHaveLength(1);
    const accountInfo = vi.spyOn(stack.rail, "getAccountInfo");
    await runBonusWatcher(watcherDeps);
    expect(accountInfo).not.toHaveBeenCalled();
    expect(
      emit.mock.calls.filter(([type]) => type === "bonus_optin_expired"),
    ).toHaveLength(1);
  });

  it("claimed_bonus_past_deadline_with_an_in_flight_job_is_not_expired", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const address = account.addr.toString();
    seedBonus(stack, account, "claimed");
    await insertPreparedJob(stack, account, "algo", "submitted");
    stack.rail.control.setAccountInfo(address, { optedInUsdc: false });
    stack.setNow(stack.now() + 2 * DAY_MS);
    await runBonusWatcher({
      coordinator: stack.coordinator,
      db: stack.database.db,
      rail: stack.rail,
      now: stack.now,
    });
    const bonus = stack.database.db
      .select()
      .from(schema.bonuses)
      .where(eq(schema.bonuses.player, address))
      .get();
    expect(bonus?.status).toBe("claimed");
  });

  it("watcher_opt_in_observation_cancels_the_pending_algo_leg_and_reports_an_advance", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const address = account.addr.toString();
    seedBonus(stack, account, "claimed");
    insertPendingJob(stack, account, "algo");
    stack.rail.control.setAccountInfo(address, { optedInUsdc: true });
    const advanced = await runBonusWatcher({
      coordinator: stack.coordinator,
      db: stack.database.db,
      rail: stack.rail,
      now: stack.now,
    });
    expect(advanced).toBe(1);
    const bonus = stack.database.db
      .select()
      .from(schema.bonuses)
      .where(eq(schema.bonuses.player, address))
      .get();
    expect(bonus?.status).toBe("opted_in");
    expect(
      stack.database.db
        .select()
        .from(schema.fundingJobs)
        .where(eq(schema.fundingJobs.player, address))
        .all(),
    ).toHaveLength(0);
  });

  it("admin_revive_returns_an_expired_bonus_to_claimed_with_a_fresh_deadline", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const address = account.addr.toString();
    seedBonus(stack, account, "claimed");
    stack.database.db
      .update(schema.bonuses)
      .set({ status: "expired" })
      .where(eq(schema.bonuses.player, address))
      .run();
    stack.setNow(stack.now() + 5 * DAY_MS);
    const result = await reviveExpiredBonus(stack.deps, address, "admin:test");
    expect(result.status).toBe("claimed");
    const bonus = stack.database.db
      .select()
      .from(schema.bonuses)
      .where(eq(schema.bonuses.player, address))
      .get();
    expect(bonus?.status).toBe("claimed");
    expect(bonus?.optInDeadlineAt).toBe(
      stack.now() + stack.config().BONUS_OPTIN_EXPIRY_DAYS * DAY_MS,
    );
    const again = await reviveExpiredBonus(stack.deps, address, "admin:test");
    expect(again.status).toBe("not_expired");
  });

  it("funding_scheduler_honors_next_due_caps_the_delay_and_reruns_on_kick", async () => {
    vi.useFakeTimers();
    try {
      const runs: number[] = [];
      const nextDues: (number | null)[] = [Date.now() + 5_000, null, null];
      const scheduler = createFundingScheduler({
        run: async () => {
          runs.push(Date.now());
          return nextDues.shift() ?? null;
        },
        now: Date.now,
        maxDelayMs: 60_000,
      });
      await scheduler.kick();
      expect(runs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runs).toHaveLength(2);
      // null nextDue → sleeps the capped max, not forever
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toHaveLength(3);
      await scheduler.kick();
      expect(runs).toHaveLength(4);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(runs).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Server robustness F7 — funding waiting states are observable (spec 2026-08-26)", () => {
  it("guard_blocked_job_warns_once_per_reason_and_gauges_reflect_funding_state", async () => {
    const stack = setup();
    const gauges = new FundingGauges();
    const deps = { ...stack.deps, gauges };
    const warn = vi.spyOn(stack.deps.logger, "warn");
    const blocked = algosdk.generateAccount();
    seedBonus(stack, blocked, "opted_in");
    insertPendingJob(stack, blocked, "usdc");
    const waiting = algosdk.generateAccount();
    seedBonus(stack, waiting, "claimed");
    await insertPreparedJob(stack, waiting, "algo", "submitted").then(
      ({ id }) => {
        stack.database.db
          .update(schema.fundingJobs)
          .set({
            status: "failed",
            payloadB64: null,
            txid: null,
            lastValidRound: null,
          })
          .where(eq(schema.fundingJobs.id, id))
          .run();
      },
    );
    stack.rail.control.setBalances(stack.rail.bonusAddress, {
      usdcMicroUsdc: 0,
    });
    await runFundingExecutor(deps);
    await runFundingExecutor(deps);
    const guardWarns = warn.mock.calls.filter(
      ([, message]) => message === "funding blocked by send guard",
    );
    expect(guardWarns).toHaveLength(1);
    expect(guardWarns[0]?.[0]).toMatchObject({ reason: "usdc_balance" });
    const snapshot = gauges.snapshot();
    expect(snapshot.fundingJobsBlocked).toEqual({ usdc_balance: 1 });
    expect(snapshot.bonusesAwaitingOptIn).toBe(1);
    expect(snapshot.fundingJobsFailed).toBe(1);
    // Reason transition warns again; unchanged reason stays quiet.
    stack.rail.control.setBalances(stack.rail.bonusAddress, {
      usdcMicroUsdc: 0,
      algoMicroAlgo: 0,
    });
    await runFundingExecutor(deps);
    expect(
      warn.mock.calls.filter(
        ([, message]) => message === "funding blocked by send guard",
      ),
    ).toHaveLength(1);
  });
});

describe("Server robustness F1 review fix — expiry requires a resolved ALGO leg", () => {
  it("past_deadline_bonus_with_a_failed_algo_leg_is_not_expired", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const address = account.addr.toString();
    seedBonus(stack, account, "claimed");
    const jobId = insertPendingJob(stack, account, "algo");
    stack.database.db
      .update(schema.fundingJobs)
      .set({ status: "failed" })
      .where(eq(schema.fundingJobs.id, jobId))
      .run();
    stack.rail.control.setAccountInfo(address, { optedInUsdc: false });
    stack.setNow(stack.now() + 2 * 86_400_000);
    await runBonusWatcher({
      coordinator: stack.coordinator,
      db: stack.database.db,
      rail: stack.rail,
      now: stack.now,
    });
    expect(
      stack.database.db
        .select({ status: schema.bonuses.status })
        .from(schema.bonuses)
        .where(eq(schema.bonuses.player, address))
        .get()?.status,
    ).toBe("claimed");
  });

  it("past_deadline_bonus_with_a_skipped_algo_leg_expires", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const address = account.addr.toString();
    seedBonus(stack, account, "claimed");
    stack.database.db
      .update(schema.bonuses)
      .set({ algoSkippedAt: stack.now() })
      .where(eq(schema.bonuses.player, address))
      .run();
    stack.rail.control.setAccountInfo(address, { optedInUsdc: false });
    stack.setNow(stack.now() + 2 * 86_400_000);
    await runBonusWatcher({
      coordinator: stack.coordinator,
      db: stack.database.db,
      rail: stack.rail,
      now: stack.now,
    });
    expect(
      stack.database.db
        .select({ status: schema.bonuses.status })
        .from(schema.bonuses)
        .where(eq(schema.bonuses.player, address))
        .get()?.status,
    ).toBe("expired");
  });
});
