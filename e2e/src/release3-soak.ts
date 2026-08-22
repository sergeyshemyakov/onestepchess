import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockRailState } from "@onestepchess/rail-mock";
import { schema } from "@onestepchess/server";
import algosdk from "algosdk";
import { z } from "zod";
import {
  createPublicAgentDriver,
  type PublicAgentDriver,
} from "./public-driver.js";
import {
  createRelease3Harness,
  ledgerConservation,
  type Release3Harness,
} from "./release3-harness.js";

const soakOptionsSchema = z.object({
  poolTarget: z.number().int().positive(),
  sessions: z.number().int().positive(),
  moveTarget: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  databasePath: z.string().min(1).optional(),
  restartEveryMoves: z.number().int().positive().optional(),
  captureLogs: z.boolean().default(true),
});
export type Release3SoakOptions = z.input<typeof soakOptionsSchema>;

const latencySchema = z.object({
  count: z.number().int().nonnegative(),
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});

export const release3SoakReportSchema = z.object({
  command: z.literal("release3_soak_64x100x10000"),
  profile: z.literal("mock:local"),
  noRealMoney: z.literal(true),
  config: z.object({
    gamePoolTarget: z.number().int().positive(),
    sessions: z.number().int().positive(),
    acceptedMoves: z.number().int().positive(),
    seed: z.number().int().nonnegative(),
  }),
  durationMs: z.number().nonnegative(),
  restarts: z.number().int().nonnegative(),
  churn: z.object({
    noBoardResponses: z.number().int().nonnegative(),
    expiredClaims: z.number().int().nonnegative(),
    sseConnectionsOpened: z.number().int().nonnegative(),
    sseConnectionsClosed: z.number().int().nonnegative(),
  }),
  faults: z.record(
    z.string(),
    z.object({
      injected: z.boolean(),
      converged: z.boolean(),
      detail: z.string(),
    }),
  ),
  latency: z.object({
    claim: latencySchema,
    read: latencySchema,
    settle: latencySchema,
    coordinatorCommand: latencySchema,
    serverMoveContribution: latencySchema,
  }),
  resources: z.object({
    cpuUserMicros: z.number().int().nonnegative(),
    cpuSystemMicros: z.number().int().nonnegative(),
    rssStartBytes: z.number().int().nonnegative(),
    rssEndBytes: z.number().int().nonnegative(),
    rssPeakBytes: z.number().int().nonnegative(),
    sqliteBytes: z.number().int().nonnegative(),
    walBytes: z.number().int().nonnegative(),
  }),
  final: z.object({
    invariantViolations: z.number().int().nonnegative(),
    ledgerBalanced: z.boolean(),
    ledgerTotalMicroUsdc: z.number().int(),
    duplicateClientTxids: z.number().int().nonnegative(),
    duplicatePayouts: z.number().int().nonnegative(),
    strandedPaymentIntents: z.number().int().nonnegative(),
    strandedPayoutJobs: z.number().int().nonnegative(),
    reconciliationClean: z.boolean(),
    structuredLogLines: z.number().int().nonnegative(),
    malformedLogLines: z.number().int().nonnegative(),
    secretFindings: z.number().int().nonnegative(),
  }),
  budgets: z.object({
    claimReadP95Under50Ms: z.boolean(),
    coordinatorP95Under10Ms: z.boolean(),
    serverMoveP95Under100Ms: z.boolean(),
  }),
});
export type Release3SoakReport = z.infer<typeof release3SoakReportSchema>;

function deterministicAccount(seed: number, index: number): algosdk.Account {
  const bytes = createHash("sha256")
    .update(`one-step-chess-release3-soak:${seed}:${index}`)
    .digest();
  return algosdk.mnemonicToSecretKey(
    algosdk.mnemonicFromSeed(new Uint8Array(bytes)),
  );
}

function percentile(values: readonly number[], percentage: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.floor((percentage / 100) * ordered.length),
  );
  return Math.round((ordered[index] ?? 0) * 1_000) / 1_000;
}

function latency(values: readonly number[]) {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs:
      Math.round(
        values.reduce((maximum, value) => Math.max(maximum, value), 0) * 1_000,
      ) / 1_000,
  };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function duplicates(values: readonly string[]): number {
  return values.length - new Set(values).size;
}

export async function runRelease3Soak(
  rawOptions: Release3SoakOptions,
): Promise<Release3SoakReport> {
  const options = soakOptionsSchema.parse(rawOptions);
  const workingDirectory =
    options.databasePath === undefined
      ? await mkdtemp(join(tmpdir(), "osc-release3-soak-"))
      : dirname(resolve(options.databasePath));
  const databasePath =
    options.databasePath ?? join(workingDirectory, "osc.sqlite");
  await mkdir(dirname(databasePath), { recursive: true });

  const initialTreasuryMicroUsdc = 10_000_000;
  const railState = createMockRailState({
    usdcMicroUsdc: initialTreasuryMicroUsdc,
    algoMicroAlgo: 10_000_000,
  });
  const config = {
    GAME_POOL_TARGET: options.poolTarget,
    QUOTA_AGENT: Math.max(10_000, options.moveTarget),
    MIN_PLY_INTERVAL_SECONDS: 1,
    RATE_LIMIT_AUTH_PER_IP_MIN: 100_000,
    RATE_LIMIT_CLAIMS_PER_IP_MIN: 1_000_000,
  };
  let stack: Release3Harness = await createRelease3Harness({
    config,
    databasePath,
    initialTreasuryMicroUsdc,
    railState,
    captureLogs: options.captureLogs,
  });
  let agents = Array.from({ length: options.sessions }, (_, index) =>
    createPublicAgentDriver({
      serverUrl: stack.baseUrl,
      fetch: stack.fetchFor(`10.75.${Math.floor(index / 250)}.${index + 1}`),
      nickname: `soak-agent-${String(index + 1).padStart(3, "0")}`,
      account: deterministicAccount(options.seed, index),
      maxStakeMicroUsdc: 10_000,
      sessionBudgetMicroUsdc: Math.max(1_000_000, options.moveTarget * 1_000),
      nonce: (() => {
        let value = 0;
        return () => `soak_${index}_${++value}`;
      })(),
    }),
  );

  const claimLatencies: number[] = [];
  const readLatencies: number[] = [];
  const settleLatencies: number[] = [];
  const commandLatencies: number[] = [];
  const serverMoveLatencies: number[] = [];
  let structuredLogLines = 0;
  let malformedLogLines = 0;
  let secretFindings = 0;
  const startedAt = performance.now();
  const resourceStart = process.resourceUsage();
  const rssStartBytes = process.memoryUsage().rss;
  let rssPeakBytes = rssStartBytes;
  let acceptedMoves = 0;
  let noBoardResponses = 0;
  let expiredClaims = 0;
  let restarts = 0;
  let nextRestartAt = options.restartEveryMoves;
  let sseConnectionsOpened = 0;
  let sseConnectionsClosed = 0;
  const faults: Record<
    string,
    { injected: boolean; converged: boolean; detail: string }
  > = {};

  const harvestHarnessMetrics = () => {
    commandLatencies.push(...stack.commandDurationsMs);
    serverMoveLatencies.push(...stack.moveCommandDurationsMs);
    structuredLogLines += stack.logStats.structured;
    malformedLogLines += stack.logStats.malformed;
    secretFindings += stack.logStats.secretFindings;
  };

  try {
    for (let start = 0; start < agents.length; start += 25) {
      await Promise.all(
        agents.slice(start, start + 25).map((agent) => agent.register()),
      );
    }

    const streamClosers = agents.map((agent, index) => {
      sseConnectionsOpened += 1;
      return stack.events.open({
        session: {
          address: agent.address,
          kind: "agent",
          jti: `soak-sse-${index}`,
          exp: Math.floor(stack.now() / 1_000) + 3_600,
        },
        cursor: null,
        sink: { write() {}, close() {} },
      });
    });
    for (const close of streamClosers) {
      close();
      sseConnectionsClosed += 1;
    }
    faults.sse_reconnect_reset_churn = {
      injected: true,
      converged: stack.events.clientCount === 0,
      detail: `${sseConnectionsOpened} public-session streams opened and closed`,
    };

    const expiringAgent = agents[0];
    if (expiringAgent === undefined) throw new Error("soak agent missing");
    const expiringClaim = await expiringAgent.claim();
    if (expiringClaim === null) throw new Error("expiry fault claim missing");
    stack.advance(stack.config.CLAIM_TTL_AGENT * 1_000 + 1);
    await stack.coordinator.dispatch({
      type: "TimerFired",
      payload: { kind: "claimDeadline", refId: expiringClaim.claimId },
      refIds: [expiringClaim.claimId],
    });
    const expired = await expiringAgent.claimStatus(expiringClaim.claimId);
    expiredClaims += expired.status === "expired" ? 1 : 0;
    faults.claim_expiry = {
      injected: true,
      converged: expired.status === "expired",
      detail: `claim ${expiringClaim.claimId} expired without a payment intent`,
    };

    const ambiguousAgent = agents[1];
    if (ambiguousAgent === undefined)
      throw new Error("ambiguous agent missing");
    const ambiguousClaim = await ambiguousAgent.claim();
    if (ambiguousClaim === null)
      throw new Error("ambiguous fault claim missing");
    stack.rail.control.queueSettle({
      ok: false,
      reason: "unavailable",
      applied: true,
    });
    try {
      await ambiguousAgent.play(ambiguousClaim);
    } catch {
      // PAYMENT_PENDING is the expected public outcome; recovery owns truth.
    }
    await stack.recoverPayments();
    const ambiguousStatus = await ambiguousAgent.claimStatus(
      ambiguousClaim.claimId,
    );
    if (ambiguousStatus.status === "moved") acceptedMoves += 1;
    faults.ambiguous_settlement_applied = {
      injected: true,
      converged: ambiguousStatus.status === "moved",
      detail: "lost applied settle response recovered through public status",
    };

    const unappliedAgent = agents[2];
    if (unappliedAgent === undefined)
      throw new Error("unapplied agent missing");
    const unappliedClaim = await unappliedAgent.claim();
    if (unappliedClaim === null)
      throw new Error("unapplied fault claim missing");
    stack.rail.control.queueSettle({
      ok: false,
      reason: "unavailable",
      applied: false,
    });
    try {
      await unappliedAgent.play(unappliedClaim);
    } catch {
      // The persisted settling row remains locked until the recovery boundary.
    }
    stack.advance(
      (stack.config.PAYMENT_RECOVERY_TIMEOUT_SECONDS +
        stack.config.CLAIM_TTL_AGENT +
        1) *
        1_000,
    );
    await stack.recoverPayments();
    await stack.coordinator.dispatch({
      type: "TimerFired",
      payload: { kind: "claimDeadline", refId: unappliedClaim.claimId },
      refIds: [unappliedClaim.claimId],
    });
    const unappliedStatus = await unappliedAgent.claimStatus(
      unappliedClaim.claimId,
    );
    faults.ambiguous_settlement_unapplied = {
      injected: true,
      converged: unappliedStatus.status === "expired",
      detail: "unapplied ambiguity failed after its finite recovery boundary",
    };

    while (acceptedMoves < options.moveTarget) {
      const remaining = options.moveTarget - acceptedMoves;
      const candidates = agents.slice(0, Math.min(agents.length, remaining));
      const claims = await Promise.all(
        candidates.map(async (agent) => {
          const started = performance.now();
          const claim = await agent.claim();
          claimLatencies.push(performance.now() - started);
          if (claim === null) noBoardResponses += 1;
          return { agent, claim };
        }),
      );
      const playable = claims.filter(
        (
          result,
        ): result is {
          readonly agent: PublicAgentDriver;
          readonly claim: NonNullable<typeof result.claim>;
        } => result.claim !== null,
      );
      if (playable.length === 0) {
        stack.advancePacing();
        await stack.poolTick();
        continue;
      }
      await Promise.all(
        playable.map(async ({ agent, claim }) => {
          const started = performance.now();
          await agent.play(claim);
          settleLatencies.push(performance.now() - started);
        }),
      );
      acceptedMoves += playable.length;
      stack.advancePacing();
      await stack.poolTick();

      if (acceptedMoves % 500 < playable.length) {
        const readStarted = performance.now();
        await agents[acceptedMoves % agents.length]?.client.profile();
        readLatencies.push(performance.now() - readStarted);
        await stack.runPayouts();
      }
      rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);

      if (
        nextRestartAt !== undefined &&
        acceptedMoves >= nextRestartAt &&
        acceptedMoves < options.moveTarget
      ) {
        harvestHarnessMetrics();
        stack.close();
        stack = await createRelease3Harness({
          config,
          databasePath,
          initialTreasuryMicroUsdc,
          railState,
          captureLogs: options.captureLogs,
        });
        agents = agents.map((agent, index) =>
          agent.reconnect(
            stack.fetchFor(`10.75.${Math.floor(index / 250)}.${index + 1}`),
          ),
        );
        restarts += 1;
        nextRestartAt += options.restartEveryMoves ?? options.moveTarget;
      }
    }

    stack.rail.control.queueSubmitPrepared({
      ok: false,
      reason: "rejected",
      detail: "soak injected payout rejection",
    });
    // Drain until every job is terminal: "no failed jobs" alone would report
    // convergence while a job still sits in retry backoff.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await stack.runPayouts();
      const unresolved = stack.database.db
        .select()
        .from(schema.payoutJobs)
        .all()
        .filter((job) => job.status !== "confirmed").length;
      if (unresolved === 0) break;
      stack.advance(60_000);
    }
    const jobsAfterRejection = stack.database.db
      .select()
      .from(schema.payoutJobs)
      .all();
    const payoutRowsAfterRejection = stack.database.db
      .select()
      .from(schema.ledger)
      .all()
      .filter((row) => row.refType === "payout");
    const payoutRecoveryConverged =
      jobsAfterRejection.every((job) => job.status === "confirmed") &&
      jobsAfterRejection.every(
        (job) =>
          payoutRowsAfterRejection.filter((row) => row.refId === job.id)
            .length === 1,
      );
    faults.payout_rejection_recovery = {
      injected: true,
      converged: payoutRecoveryConverged,
      detail:
        "one rejected prepared batch converged to confirmed with a single debit per job",
    };

    stack.rail.control.setHealth(false);
    const degradedMode = await stack.probeFacilitator();
    stack.rail.control.setHealth(true);
    const recoveredMode = await stack.probeFacilitator();
    faults.facilitator_health_loss_recovery = {
      injected: true,
      converged: degradedMode === "paused" && recoveredMode === "running",
      detail: `${degradedMode} -> ${recoveredMode}`,
    };

    const actualTreasuryBalance = await stack.rail.getBalances(
      stack.rail.treasuryAddress,
    );
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: actualTreasuryBalance.usdcMicroUsdc - 1_000,
    });
    const driftedReconciliation = await stack.reconcile("scheduled");
    // Clear the override instead of pinning the pre-drift snapshot: payouts
    // recovering from the injected rejection legitimately debit the chain
    // after this point, and a pinned balance would mask them.
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {});
    const cleanReconciliation = await stack.reconcile("admin");
    faults.reconciliation = {
      injected: true,
      converged: !driftedReconciliation.ok && cleanReconciliation.ok,
      detail: `drift ${driftedReconciliation.driftMicroUsdc} -> ${cleanReconciliation.driftMicroUsdc} micro-USDC`,
    };
    faults.controlled_restart = {
      injected: restarts > 0,
      converged: restarts > 0 && stack.invariantViolations().length === 0,
      detail: `${restarts} persistent SQLite/shared-rail restarts`,
    };
    faults.same_side_cooldown_churn = {
      injected: true,
      converged: acceptedMoves === options.moveTarget,
      detail: `${noBoardResponses} bounded no-board outcomes under churn`,
    };

    await stack.runPayouts();
    harvestHarnessMetrics();
    const resourceEnd = process.resourceUsage();
    const rssEndBytes = process.memoryUsage().rss;
    rssPeakBytes = Math.max(rssPeakBytes, rssEndBytes);
    const intents = stack.database.db
      .select()
      .from(schema.paymentIntents)
      .all();
    const jobs = stack.database.db.select().from(schema.payoutJobs).all();
    const payoutLedger = stack.database.db
      .select()
      .from(schema.ledger)
      .all()
      .filter((row) => row.refType === "payout");
    const conservation = ledgerConservation(stack.database);
    const invariantViolations = stack.invariantViolations();
    const railBalance = await stack.rail.getBalances(
      stack.rail.treasuryAddress,
    );
    const reconciliationClean =
      cleanReconciliation.ok &&
      railBalance.usdcMicroUsdc === conservation.totalDelta;
    const claimMetrics = latency(claimLatencies);
    const readMetrics = latency(readLatencies);
    const settleMetrics = latency(settleLatencies);
    const commandMetrics = latency(commandLatencies);
    const serverMoveMetrics = latency(serverMoveLatencies);

    return release3SoakReportSchema.parse({
      command: "release3_soak_64x100x10000",
      profile: "mock:local",
      noRealMoney: true,
      config: {
        gamePoolTarget: options.poolTarget,
        sessions: options.sessions,
        acceptedMoves,
        seed: options.seed,
      },
      durationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
      restarts,
      churn: {
        noBoardResponses,
        expiredClaims,
        sseConnectionsOpened,
        sseConnectionsClosed,
      },
      faults,
      latency: {
        claim: claimMetrics,
        read: readMetrics,
        settle: settleMetrics,
        coordinatorCommand: commandMetrics,
        serverMoveContribution: serverMoveMetrics,
      },
      resources: {
        cpuUserMicros: resourceEnd.userCPUTime - resourceStart.userCPUTime,
        cpuSystemMicros:
          resourceEnd.systemCPUTime - resourceStart.systemCPUTime,
        rssStartBytes,
        rssEndBytes,
        rssPeakBytes,
        sqliteBytes: await fileSize(databasePath),
        walBytes: await fileSize(`${databasePath}-wal`),
      },
      final: {
        invariantViolations: invariantViolations.length,
        ledgerBalanced: conservation.balanced,
        ledgerTotalMicroUsdc: conservation.totalDelta,
        duplicateClientTxids: duplicates(
          intents.map((intent) => intent.clientTxid),
        ),
        duplicatePayouts: duplicates(payoutLedger.map((row) => row.refId)),
        strandedPaymentIntents: intents.filter(
          (intent) =>
            intent.status === "verified" || intent.status === "settling",
        ).length,
        strandedPayoutJobs: jobs.filter(
          (job) =>
            job.status === "pending" ||
            job.status === "prepared" ||
            job.status === "submitted",
        ).length,
        reconciliationClean,
        structuredLogLines,
        malformedLogLines,
        secretFindings,
      },
      budgets: {
        claimReadP95Under50Ms:
          Math.max(claimMetrics.p95Ms, readMetrics.p95Ms) < 50,
        coordinatorP95Under10Ms: commandMetrics.p95Ms < 10,
        serverMoveP95Under100Ms: serverMoveMetrics.p95Ms < 100,
      },
    });
  } finally {
    stack.close();
    if (options.databasePath === undefined) {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

export async function release3_soak_64x100x10000(
  outputPath: string,
): Promise<Release3SoakReport> {
  const report = await runRelease3Soak({
    poolTarget: 64,
    sessions: 100,
    moveTarget: 10_000,
    seed: 20_260_726,
    restartEveryMoves: 2_500,
    captureLogs: true,
  });
  const parsed = release3SoakReportSchema.parse(report);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(resolve(entry)).href
) {
  const command = process.argv[2];
  if (command !== "release3_soak_64x100x10000") {
    process.stderr.write(
      "usage: release3-soak.ts release3_soak_64x100x10000 [report.json]\n",
    );
    process.exitCode = 2;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const output = resolve(
      process.argv[3] ??
        join(root, "artifacts/release3/release3-soak-report.json"),
    );
    release3_soak_64x100x10000(output)
      .then((report) => {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.stack : String(error)}\n`,
        );
        process.exitCode = 1;
      });
  }
}
