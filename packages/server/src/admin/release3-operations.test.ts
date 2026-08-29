import { gameRulesSchema, STARTING_FEN } from "@onestepchess/core";
import { createMockRail } from "@onestepchess/rail-mock";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../auth/jwt.js";
import { initializeSystemState } from "../boot.js";
import { type ServerConfig, serverConfigSchema } from "../config.js";
import { Coordinator } from "../coordinator/queue.js";
import { registerResolution } from "../coordinator/resolution.js";
import { TimerService } from "../coordinator/timers.js";
import { CoordinatorViews } from "../coordinator/views.js";
import { appendLedgerEntry } from "../db/ledger.js";
import { type OpenedDatabase, openDatabase, schema } from "../db/open.js";
import { createApp } from "../http/app.js";
import { createLogger } from "../logger.js";
import { Metrics } from "../metrics.js";
import {
  OperationalAlerts,
  sanitizeOperationalPayload,
} from "../operations/alerts.js";
import { readPauseState } from "../operations/pause.js";
import {
  OperationalState,
  probeFacilitator,
  registerOperationalCommands,
  runReconciliation,
} from "../operations/reconciliation.js";
import { registerAdminCommands } from "./commands.js";
import { registerAdminRoutes } from "./routes.js";

const JWT_SECRET = "admin-test-secret-that-is-long-enough";
const ADMIN_TOKEN = "runbook-token";
const databases: OpenedDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
});

function setup(overrides: Record<string, unknown> = {}) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  const baseConfig = serverConfigSchema.parse({
    GAME_POOL_TARGET: 2,
    ...overrides,
  });
  let config: ServerConfig = baseConfig;
  let now = 1_000_000;
  const logger = createLogger({ level: "silent" });
  const rail = createMockRail({
    initialTreasury: {
      usdcMicroUsdc: 1_000_000,
      algoMicroAlgo: 2_000_000,
    },
  });
  initializeSystemState({
    db: database.db,
    railKind: "mock",
    config,
    treasuryAddress: rail.treasuryAddress,
    banner: undefined,
    now,
    logger,
  });
  database.db
    .insert(schema.players)
    .values([
      {
        address: "admin-wallet",
        kind: "human",
        nickname: "admin",
        createdAt: now,
      },
      {
        address: "alice",
        kind: "human",
        nickname: "alice",
        createdAt: now,
      },
    ])
    .run();
  const views = new CoordinatorViews();
  views.rebuild(database.db, now);
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger,
    now: () => now,
    views,
  });
  const timers = new TimerService({
    now: () => now,
    onFire: () => {},
  });
  const transport = vi.fn(async () => ({}));
  const alerts = new OperationalAlerts({
    url: "https://hooks.example/ops",
    dedupeSeconds: () => config.ALERT_DEDUPE_SECONDS,
    now: () => now,
    transport,
    logger,
    secrets: [JWT_SECRET, ADMIN_TOKEN],
  });
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
  const metrics = new Metrics({ now: () => now, startedAt: now - 5_000 });
  const resolution = {
    coordinator,
    db: database.db,
    logger,
    config: () => config,
    metrics,
  };
  registerResolution(resolution);
  registerAdminCommands({
    coordinator,
    db: database.db,
    views,
    timers,
    config: () => config,
    setConfig: (next) => {
      config = next;
    },
    baseConfig,
    resolution,
    alerts,
  });
  const app = createApp({
    logger,
    publicBaseUrl: "https://osc.example",
    mode: () => readPauseState(database.db).mode,
  });
  registerAdminRoutes(app, {
    db: database.db,
    jwtSecret: JWT_SECRET,
    adminToken: ADMIN_TOKEN,
    adminAddresses: ["admin-wallet"],
    now: () => now,
    rail,
    views,
    config: () => config,
    baseConfig,
    state,
    metrics,
    clientCount: () => 0,
    secrets: [JWT_SECRET, ADMIN_TOKEN],
    coordinator,
    reconciliation,
  });
  return {
    app,
    database,
    coordinator,
    rail,
    transport,
    reconciliation,
    views,
    config: () => config,
    now: () => now,
    setNow(value: number) {
      now = value;
    },
  };
}

function tokenHeaders() {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

function walletHeaders(stack: ReturnType<typeof setup>) {
  const nowSeconds = Math.floor(stack.now() / 1_000);
  const token = signSession(JWT_SECRET, {
    sub: "admin-wallet",
    kind: "human",
    jti: "admin-session",
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
  });
  return { Cookie: `osc_session=${token}` };
}

function seedGame(stack: ReturnType<typeof setup>, id = "gm_admin") {
  const now = stack.now();
  stack.database.db
    .insert(schema.games)
    .values({
      id,
      name: id,
      status: "active",
      fen: STARTING_FEN,
      historyJson: "[]",
      rulesJson: JSON.stringify(gameRulesSchema.parse(stack.config())),
      lastPlyAt: now,
      createdAt: now,
    })
    .run();
  stack.views.rebuild(stack.database.db, now);
  return id;
}

function seedMovedStake(stack: ReturnType<typeof setup>, gameId: string) {
  const now = stack.now();
  stack.database.db
    .insert(schema.claims)
    .values({
      id: `clm_${gameId}`,
      gameId,
      player: "alice",
      side: "white",
      demo: false,
      stakeMicrousdc: 1_000,
      status: "moved",
      createdAt: now,
      deadline: now + 60_000,
      movedAt: now,
      movedPly: 1,
      moveUci: "e2e4",
      moveSan: "e4",
      fenBefore: STARTING_FEN,
      fenAfter: STARTING_FEN,
    })
    .run();
  stack.database.db
    .insert(schema.stakeEntries)
    .values({
      id: `se_${gameId}`,
      gameId,
      claimId: `clm_${gameId}`,
      player: "alice",
      side: "white",
      kind: "human",
      amount: 1_000,
      payTxid: `tx_${gameId}`,
      ply: 1,
      createdAt: now,
    })
    .run();
}

async function jsonRequest(
  stack: ReturnType<typeof setup>,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
) {
  return stack.app.request(path, {
    method,
    headers: {
      ...tokenHeaders(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Release 3 reconciliation and recovery", () => {
  it("reconciliation_clean_history_and_opening_baseline_are_single_shot", async () => {
    const stack = setup();
    const first = await runReconciliation(stack.reconciliation, "boot");
    const second = await runReconciliation(stack.reconciliation, "scheduled");

    expect(first).toMatchObject({ driftMicroUsdc: 0, ok: true });
    expect(second).toMatchObject({ driftMicroUsdc: 0, ok: true });
    expect(
      stack.database.db
        .select()
        .from(schema.ledger)
        .all()
        .filter((entry) => entry.refType === "opening"),
    ).toHaveLength(1);
  });

  it("reconciliation_tolerates_only_settling_inbound_and_submitted_outbound_work", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    const gameId = seedGame(stack);
    stack.database.db
      .insert(schema.claims)
      .values({
        id: "clm_open",
        gameId,
        player: "alice",
        side: "white",
        stakeMicrousdc: 100,
        status: "open",
        createdAt: stack.now(),
        deadline: stack.now() + 1_000,
      })
      .run();
    stack.database.db
      .insert(schema.paymentIntents)
      .values({
        id: "pi_settling",
        claimId: "clm_open",
        player: "alice",
        moveUci: "e2e4",
        amount: 100,
        clientTxid: "client-settling",
        status: "settling",
        createdAt: stack.now(),
        updatedAt: stack.now(),
      })
      .run();
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 1_000_100,
    });
    const tolerated = await runReconciliation(
      stack.reconciliation,
      "scheduled",
    );
    expect(tolerated).toMatchObject({
      driftMicroUsdc: -100,
      inboundToleranceMicroUsdc: 100,
      ok: true,
    });

    stack.database.db
      .update(schema.paymentIntents)
      .set({ status: "verified" })
      .run();
    const rejected = await runReconciliation(stack.reconciliation, "scheduled");
    expect(rejected.ok).toBe(false);
  });

  it("reconciliation_tolerates_recently_booked_stake_missing_from_chain_snapshot", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    stack.setNow(1_060_000);
    appendLedgerEntry(stack.database.db, {
      ts: stack.now(),
      account: "treasury",
      deltaMicrousdc: 1_000,
      refType: "stake",
      refId: "pi_recent",
    });
    // The chain snapshot (still 1_000_000) has not caught up with the
    // just-confirmed settlement; 5s later is inside the 30s skew window.
    stack.setNow(1_065_000);

    const report = await runReconciliation(stack.reconciliation, "scheduled");

    expect(report).toMatchObject({ driftMicroUsdc: 1_000, ok: true });
    expect(readPauseState(stack.database.db)).toMatchObject({
      mode: "running",
    });
    expect(
      stack.database.db
        .select()
        .from(schema.errorLog)
        .all()
        .filter((row) => row.code === "reconciliation_drift"),
    ).toHaveLength(0);
    expect(stack.transport).not.toHaveBeenCalled();
  });

  it("reconciliation_flags_positive_drift_older_than_chain_skew_window", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    stack.setNow(1_060_000);
    appendLedgerEntry(stack.database.db, {
      ts: stack.now(),
      account: "treasury",
      deltaMicrousdc: 1_000,
      refType: "stake",
      refId: "pi_stale",
    });
    // 31s later the chain still lacks the funds: a real discrepancy, not skew.
    stack.setNow(1_091_000);

    const report = await runReconciliation(stack.reconciliation, "scheduled");

    expect(report).toMatchObject({ driftMicroUsdc: 1_000, ok: false });
  });

  it("reconciliation_tolerates_recently_booked_payout_still_in_chain_snapshot", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    stack.setNow(1_060_000);
    appendLedgerEntry(stack.database.db, {
      ts: stack.now(),
      account: "treasury",
      deltaMicrousdc: -1_000,
      refType: "payout",
      refId: "job_recent",
    });
    stack.setNow(1_065_000);

    const report = await runReconciliation(stack.reconciliation, "scheduled");

    expect(report).toMatchObject({ driftMicroUsdc: -1_000, ok: true });
    expect(readPauseState(stack.database.db)).toMatchObject({
      mode: "running",
    });
  });

  it("reconciliation_drift_alerts_once_without_pausing", async () => {
    const stack = setup({ ALERT_DEDUPE_SECONDS: 600 });
    await runReconciliation(stack.reconciliation, "boot");
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 999_000,
    });
    await runReconciliation(stack.reconciliation, "scheduled");
    await runReconciliation(stack.reconciliation, "scheduled");

    expect(readPauseState(stack.database.db)).toMatchObject({
      mode: "running",
      causes: [],
      banner: null,
    });
    expect(stack.transport).toHaveBeenCalledTimes(1);
  });

  it("reconciliation_drift_realerts_after_a_clean_run", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 999_000,
    });
    await runReconciliation(stack.reconciliation, "scheduled");
    await runReconciliation(stack.reconciliation, "scheduled");
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 1_000_000,
    });
    await runReconciliation(stack.reconciliation, "scheduled");
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 999_000,
    });
    await runReconciliation(stack.reconciliation, "scheduled");

    expect(
      stack.database.db
        .select()
        .from(schema.errorLog)
        .all()
        .filter((row) => row.code === "reconciliation_drift"),
    ).toHaveLength(2);
  });

  it("reconciliation_drift_recovers_only_its_pause_cause_after_clean_probe", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    await jsonRequest(stack, "/api/v1/admin/pause", "POST", {
      banner: "Investigating",
    });
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 999_000,
    });
    expect(
      await runReconciliation(stack.reconciliation, "scheduled"),
    ).toMatchObject({ ok: false, driftMicroUsdc: 1_000 });

    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 1_000_000,
    });
    expect(
      await runReconciliation(stack.reconciliation, "scheduled"),
    ).toMatchObject({ ok: true, driftMicroUsdc: 0 });
    expect(readPauseState(stack.database.db)).toMatchObject({
      mode: "paused",
      causes: ["manual"],
    });

    await jsonRequest(stack, "/api/v1/admin/resume", "POST");
    expect(readPauseState(stack.database.db)).toMatchObject({
      mode: "running",
      causes: [],
    });
  });

  it("pause_causes_recover_independently_without_stranding_money", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    await jsonRequest(stack, "/api/v1/admin/pause", "POST", {
      banner: "Investigating",
    });
    stack.rail.control.setHealth(false);
    await probeFacilitator(stack.reconciliation);
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 999_000,
    });
    await runReconciliation(stack.reconciliation, "scheduled");
    expect(readPauseState(stack.database.db).causes).toEqual(
      expect.arrayContaining(["manual", "facilitator"]),
    );
    stack.rail.control.setHealth(true);
    await probeFacilitator(stack.reconciliation);
    await jsonRequest(stack, "/api/v1/admin/resume", "POST");

    expect(readPauseState(stack.database.db)).toMatchObject({
      mode: "running",
      causes: [],
    });
  });

  it("operational_logs_errors_and_webhooks_are_secret_free", async () => {
    const payload = sanitizeOperationalPayload(
      {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        nested: { mnemonic: JWT_SECRET, detail: `prefix ${JWT_SECRET}` },
      },
      [JWT_SECRET, ADMIN_TOKEN],
    );
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(JWT_SECRET);
    expect(serialized).not.toContain(ADMIN_TOKEN);
    expect(serialized).toContain("[REDACTED]");
  });
});

describe("Release 3 admin reads", () => {
  it("admin_auth_accepts_allowlisted_wallet_or_constant_time_token_and_cloaks_all_others", async () => {
    const stack = setup();
    const unknown = await stack.app.request("/api/v1/no-such-route");
    const loggedOut = await stack.app.request("/api/v1/admin/overview");
    const wrongToken = await stack.app.request("/api/v1/admin/overview", {
      headers: { Authorization: "Bearer wrong" },
    });
    const token = await stack.app.request("/api/v1/admin/overview", {
      headers: tokenHeaders(),
    });
    const wallet = await stack.app.request("/api/v1/admin/overview", {
      headers: walletHeaders(stack),
    });

    expect(loggedOut.status).toBe(404);
    expect(await loggedOut.text()).toBe(await unknown.text());
    expect(await wrongToken.text()).toBe(
      JSON.stringify({
        error: "NOT_FOUND",
        hint: "unknown route",
        docs: "https://osc.example/llms.txt#err-not_found",
      }),
    );
    expect(token.status).toBe(200);
    expect(wallet.status).toBe(200);

    stack.database.db
      .update(schema.players)
      .set({ banned: true })
      .where(eq(schema.players.address, "admin-wallet"))
      .run();
    const banned = await stack.app.request("/api/v1/admin/overview", {
      headers: walletHeaders(stack),
    });
    expect(banned.status).toBe(404);
  });

  it("admin_overview_matches_operational_ground_truth", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    seedGame(stack);
    const response = await stack.app.request("/api/v1/admin/overview", {
      headers: tokenHeaders(),
    });
    const body = (await response.json()) as {
      pool: { active: number };
      treasury: { usdcMicroUsdc: number };
      reconciliation: { ok: boolean };
    };
    expect(body.pool.active).toBe(1);
    expect(body.treasury.usdcMicroUsdc).toBe(1_000_000);
    expect(body.reconciliation.ok).toBe(true);
  });

  it("admin_activity_windows_use_pinned_population_money_and_tripwire_definitions", async () => {
    const stack = setup();
    const gameId = seedGame(stack);
    seedMovedStake(stack, gameId);
    const response = await stack.app.request(
      "/api/v1/admin/activity?window=24h",
      { headers: tokenHeaders() },
    );
    const body = (await response.json()) as {
      counts: { activeHumans: number; humanMoves: number };
      tripwires: { claimMovePctAgent: number | null };
    };
    expect(body.counts).toMatchObject({ activeHumans: 1, humanMoves: 1 });
    expect(body.tripwires.claimMovePctAgent).toBeNull();
  });

  it("admin_games_and_players_expose_full_authorized_dossiers_only", async () => {
    const stack = setup();
    const gameId = seedGame(stack);
    seedMovedStake(stack, gameId);
    const games = await stack.app.request("/api/v1/admin/games?page=1", {
      headers: tokenHeaders(),
    });
    const dossier = await stack.app.request(`/api/v1/admin/games/${gameId}`, {
      headers: tokenHeaders(),
    });
    const player = await stack.app.request("/api/v1/admin/players/alice", {
      headers: tokenHeaders(),
    });
    expect(games.status).toBe(200);
    expect(await dossier.json()).toMatchObject({
      game: { id: gameId },
      stakes: [{ player: "alice" }],
    });
    expect(await player.json()).toMatchObject({
      address: "alice",
      quota: { staked: { limit: null } },
    });
  });

  it("admin_players_lists_registered_users_with_operator_metrics", async () => {
    const stack = setup();
    stack.database.db
      .update(schema.players)
      .set({
        createdAt: 100,
        wins: 3,
        draws: 2,
        losses: 1,
        points: 90,
        abandonCount: 2,
      })
      .where(eq(schema.players.address, "alice"))
      .run();
    stack.database.db
      .update(schema.players)
      .set({ createdAt: 50 })
      .where(eq(schema.players.address, "admin-wallet"))
      .run();
    stack.database.db
      .insert(schema.players)
      .values([
        {
          address: "agent-address",
          kind: "agent",
          nickname: "builder-bot",
          createdAt: 200,
        },
        {
          address: "guest_demo",
          kind: "guest",
          nickname: null,
          createdAt: 300,
        },
      ])
      .run();
    const gameId = seedGame(stack);
    seedMovedStake(stack, gameId);
    stack.database.db
      .update(schema.stakeEntries)
      .set({ payoutAmount: 2_500 })
      .where(eq(schema.stakeEntries.player, "alice"))
      .run();

    const response = await stack.app.request("/api/v1/admin/players?page=1", {
      headers: tokenHeaders(),
    });
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(3);
    expect(body.items[0]).toMatchObject({
      address: "alice",
      nickname: "alice",
      kind: "human",
      abandonCount: 2,
      points: 90,
      netPnlMicroUsdc: 1_500,
      stats: { moves: 6, wins: 3, draws: 2, losses: 1, winratePct: 75 },
      lastActiveAt: new Date(stack.now()).toISOString(),
    });
    expect(body.items).not.toContainEqual(
      expect.objectContaining({ address: "guest_demo" }),
    );

    const filtered = await stack.app.request(
      "/api/v1/admin/players?page=1&kind=agent&q=builder",
      { headers: tokenHeaders() },
    );
    expect(await filtered.json()).toMatchObject({
      total: 1,
      items: [{ address: "agent-address", kind: "agent" }],
    });
  });

  it("admin_player_winrate_excludes_draws", async () => {
    const stack = setup();
    stack.database.db
      .update(schema.players)
      .set({ wins: 3, draws: 20, losses: 1 })
      .where(eq(schema.players.address, "alice"))
      .run();

    const response = await stack.app.request("/api/v1/admin/players/alice", {
      headers: tokenHeaders(),
    });

    expect(await response.json()).toMatchObject({
      stats: { moves: 24, wins: 3, draws: 20, losses: 1, winratePct: 75 },
    });
  });

  it("admin_config_read_reports_defaults_overrides_effective_values_and_history", async () => {
    const stack = setup();
    await jsonRequest(stack, "/api/v1/admin/config/QUOTA_AGENT", "PUT", {
      value: 77,
    });
    const response = await stack.app.request("/api/v1/admin/config", {
      headers: tokenHeaders(),
    });
    const body = (await response.json()) as {
      revision: number;
      items: {
        key: string;
        overrideValue: unknown;
        description: string;
        effect: string;
      }[];
      history: unknown[];
    };
    expect(body.revision).toBe(1);
    expect(body.items.find((item) => item.key === "QUOTA_AGENT")).toMatchObject(
      {
        overrideValue: 77,
        description: "Agent claims allowed per rolling hour.",
        effect: "new_claims",
      },
    );
    expect(body.history).toHaveLength(1);
  });

  it("admin_reads_recompute_on_every_request_with_no_etag_or_cache", async () => {
    const stack = setup();
    const balances = vi.spyOn(stack.rail, "getBalances");
    const first = await stack.app.request("/api/v1/admin/overview", {
      headers: tokenHeaders(),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBeNull();
    expect(first.headers.get("cache-control")).toBe("no-store");
    // One overview computation reads two accounts: treasury and bonus.
    expect(balances).toHaveBeenCalledTimes(2);

    const repeat = await stack.app.request("/api/v1/admin/overview", {
      headers: { ...tokenHeaders(), "If-None-Match": '"whatever"' },
    });
    expect(repeat.status).toBe(200);
    expect(balances).toHaveBeenCalledTimes(4);
  });

  it("admin_activity_reflects_a_data_change_on_the_next_request", async () => {
    const stack = setup();
    const read = async () => {
      const response = await stack.app.request(
        "/api/v1/admin/activity?window=24h",
        { headers: tokenHeaders() },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        counts: { registrations: number };
      };
    };
    const before = await read();
    stack.database.db
      .insert(schema.players)
      .values({
        address: "fresh-human",
        kind: "human",
        nickname: "fresh",
        createdAt: 900_000,
      })
      .run();
    const after = await read();
    expect(after.counts.registrations).toBe(before.counts.registrations + 1);
  });
});

describe("Release 3 admin mutations", () => {
  it("admin_pause_resume_is_audited_durable_and_cause_aware", async () => {
    const stack = setup();
    const pause = await jsonRequest(stack, "/api/v1/admin/pause", "POST", {
      banner: "Custom maintenance",
    });
    const pauseAgain = await jsonRequest(stack, "/api/v1/admin/pause", "POST", {
      banner: "Custom maintenance",
    });
    const resume = await jsonRequest(stack, "/api/v1/admin/resume", "POST");
    expect(pause.status).toBe(200);
    expect(pauseAgain.status).toBe(200);
    expect(resume.status).toBe(200);
    expect(readPauseState(stack.database.db).mode).toBe("running");
    expect(stack.database.db.select().from(schema.auditLog).all()).toHaveLength(
      3,
    );
    expect(
      stack.database.db
        .select()
        .from(schema.events)
        .all()
        .filter((event) => event.type === "system_banner"),
    ).toHaveLength(2);
  });

  it("admin_config_mutation_enforces_metadata_and_snapshot_semantics", async () => {
    const stack = setup();
    const gameId = seedGame(stack);
    const beforeRules = stack.database.db
      .select({ value: schema.games.rulesJson })
      .from(schema.games)
      .get()?.value;
    const changed = await jsonRequest(
      stack,
      "/api/v1/admin/config/HUMAN_STAKE",
      "PUT",
      { value: 12_345 },
    );
    const identity = await jsonRequest(
      stack,
      "/api/v1/admin/config/CAIP2",
      "PUT",
      { value: "other:network" },
    );
    const invalid = await jsonRequest(
      stack,
      "/api/v1/admin/config/HUMAN_STAKE",
      "PUT",
      { value: -1 },
    );
    const explorerBefore = stack.config().EXPLORER_BASE_URL;
    const restart = await jsonRequest(
      stack,
      "/api/v1/admin/config/EXPLORER_BASE_URL",
      "PUT",
      { value: "https://next-explorer.example" },
    );
    expect(changed.status).toBe(200);
    expect(stack.config().HUMAN_STAKE).toBe(12_345);
    expect(restart.status).toBe(200);
    expect(stack.config().EXPLORER_BASE_URL).toBe(explorerBefore);
    expect(
      stack.database.db
        .select({ value: schema.games.rulesJson })
        .from(schema.games)
        .where(eq(schema.games.id, gameId))
        .get()?.value ?? beforeRules,
    ).toBe(beforeRules);
    expect(identity.status).toBe(400);
    expect(invalid.status).toBe(400);
  });

  it("admin_board_exposes_and_updates_the_repetition_win_margin_for_new_games", async () => {
    const stack = setup();
    const before = (await (
      await stack.app.request("/api/v1/admin/config", {
        headers: tokenHeaders(),
      })
    ).json()) as {
      items: {
        key: string;
        effectiveValue: unknown;
        effect: string;
        editable: boolean;
      }[];
    };
    expect(
      before.items.find((item) => item.key === "REPETITION_WIN_MARGIN"),
    ).toMatchObject({
      effectiveValue: 1,
      effect: "new_games",
      editable: true,
    });

    const changed = await jsonRequest(
      stack,
      "/api/v1/admin/config/REPETITION_WIN_MARGIN",
      "PUT",
      { value: 5 },
    );
    expect(changed.status).toBe(200);
    expect(stack.config().REPETITION_WIN_MARGIN).toBe(5);
  });

  it("admin_board_exposes_and_updates_the_human_board_reserve_for_new_claims", async () => {
    const stack = setup();
    const before = (await (
      await stack.app.request("/api/v1/admin/config", {
        headers: tokenHeaders(),
      })
    ).json()) as {
      items: {
        key: string;
        effectiveValue: unknown;
        description: string;
        effect: string;
        editable: boolean;
      }[];
    };
    expect(
      before.items.find((item) => item.key === "HUMAN_BOARD_RESERVE_PERCENT"),
    ).toMatchObject({
      effectiveValue: 25,
      description:
        "Minimum percentage of live boards kept free for human claims.",
      effect: "new_claims",
      editable: true,
    });

    const changed = await jsonRequest(
      stack,
      "/api/v1/admin/config/HUMAN_BOARD_RESERVE_PERCENT",
      "PUT",
      { value: 40 },
    );
    expect(changed.status).toBe(200);
    expect(stack.config().HUMAN_BOARD_RESERVE_PERCENT).toBe(40);
  });

  it("admin_abort_refunds_after_expiring_claim_and_rejects_inflight_payment", async () => {
    const stack = setup();
    const gameId = seedGame(stack);
    seedMovedStake(stack, gameId);
    const response = await jsonRequest(
      stack,
      `/api/v1/admin/games/${gameId}/abort`,
      "POST",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ gameId, refundJobs: 1 });
    expect(
      stack.database.db
        .select({ status: schema.games.status })
        .from(schema.games)
        .get()?.status,
    ).toBe("aborted");
    expect(
      stack.database.db.select().from(schema.payoutJobs).get(),
    ).toMatchObject({ reason: "refund", amount: 1_000 });

    const inFlightGame = seedGame(stack, "gm_inflight");
    stack.database.db
      .insert(schema.claims)
      .values({
        id: "clm_inflight",
        gameId: inFlightGame,
        player: "alice",
        side: "white",
        stakeMicrousdc: 1_000,
        status: "open",
        createdAt: stack.now(),
        deadline: stack.now() + 60_000,
      })
      .run();
    stack.database.db
      .insert(schema.paymentIntents)
      .values({
        id: "pi_inflight",
        claimId: "clm_inflight",
        player: "alice",
        moveUci: "e2e4",
        amount: 1_000,
        clientTxid: "client-inflight",
        status: "settling",
        createdAt: stack.now(),
        updatedAt: stack.now(),
      })
      .run();
    const rejected = await jsonRequest(
      stack,
      `/api/v1/admin/games/${inFlightGame}/abort`,
      "POST",
    );
    expect(rejected.status).toBe(409);
  });

  it("admin_ban_and_quota_changes_apply_on_the_next_request", async () => {
    const stack = setup();
    const quota = await jsonRequest(
      stack,
      "/api/v1/admin/players/alice/quota",
      "POST",
      { override: 3 },
    );
    const ban = await jsonRequest(
      stack,
      "/api/v1/admin/players/alice/ban",
      "POST",
      { banned: true },
    );
    expect(quota.status).toBe(200);
    expect(ban.status).toBe(200);
    expect(
      stack.database.db
        .select({
          banned: schema.players.banned,
          quota: schema.players.quotaOverride,
        })
        .from(schema.players)
        .where(eq(schema.players.address, "alice"))
        .get(),
    ).toEqual({ banned: true, quota: 3 });
  });

  it("admin_treasury_adjustment_requires_pause_and_exact_investigated_drift", async () => {
    const stack = setup();
    await runReconciliation(stack.reconciliation, "boot");
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      usdcMicroUsdc: 999_500,
    });
    await runReconciliation(stack.reconciliation, "scheduled");
    // Drift no longer pauses on its own, so the operator pauses manually
    // before applying the investigated adjustment.
    await jsonRequest(stack, "/api/v1/admin/pause", "POST", {
      banner: "Investigating drift",
    });
    const wrong = await jsonRequest(
      stack,
      "/api/v1/admin/treasury/adjust",
      "POST",
      { deltaMicroUsdc: 500, reason: "wrong sign" },
    );
    const exact = await jsonRequest(
      stack,
      "/api/v1/admin/treasury/adjust",
      "POST",
      { deltaMicroUsdc: -500, reason: "acknowledged sweep" },
    );
    expect(wrong.status).toBe(400);
    expect(exact.status).toBe(200);
    expect(
      stack.database.db
        .select()
        .from(schema.ledger)
        .all()
        .filter((entry) => entry.refType === "adjustment"),
    ).toHaveLength(1);
  });

  it("admin_payout_retry_rearms_safely_after_cause_removed", async () => {
    const stack = setup();
    const gameId = seedGame(stack);
    stack.database.db
      .insert(schema.payoutJobs)
      .values({
        id: "pj_failed",
        gameId,
        recipient: "alice",
        amount: 100,
        reason: "refund",
        status: "failed",
        attempts: 10,
        createdAt: stack.now(),
      })
      .run();
    const response = await jsonRequest(
      stack,
      "/api/v1/admin/payouts/pj_failed/retry",
      "POST",
    );
    expect(response.status).toBe(200);
    expect(
      stack.database.db
        .select()
        .from(schema.payoutJobs)
        .where(eq(schema.payoutJobs.id, "pj_failed"))
        .get(),
    ).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("diagnose_pause_retry_reconcile_resume", async () => {
    const stack = setup();
    const gameId = seedGame(stack, "gm_operator_drill");
    stack.database.db
      .insert(schema.payoutJobs)
      .values({
        id: "pj_operator_drill",
        gameId,
        recipient: "alice",
        amount: 100,
        reason: "refund",
        status: "failed",
        attempts: 10,
        createdAt: stack.now(),
      })
      .run();

    const overview = await stack.app.request("/api/v1/admin/overview", {
      headers: tokenHeaders(),
    });
    expect(overview.status).toBe(200);
    expect(
      stack.database.db
        .select()
        .from(schema.payoutJobs)
        .where(eq(schema.payoutJobs.id, "pj_operator_drill"))
        .get(),
    ).toMatchObject({ status: "failed", attempts: 10 });

    const pause = await jsonRequest(stack, "/api/v1/admin/pause", "POST", {
      banner: "operator drill — payout repair",
    });
    expect(pause.status).toBe(200);
    expect(readPauseState(stack.database.db).mode).toBe("paused");

    // The fixture failure is one-shot: reaching this step represents removing
    // the diagnosed mock cause before the operator re-arms durable work.
    const retry = await jsonRequest(
      stack,
      "/api/v1/admin/payouts/pj_operator_drill/retry",
      "POST",
    );
    expect(retry.status).toBe(200);
    expect(
      stack.database.db
        .select()
        .from(schema.payoutJobs)
        .where(eq(schema.payoutJobs.id, "pj_operator_drill"))
        .get(),
    ).toMatchObject({ status: "pending", attempts: 0 });

    const reconcile = await jsonRequest(
      stack,
      "/api/v1/admin/reconcile",
      "POST",
    );
    expect(reconcile.status).toBe(200);
    expect(await reconcile.json()).toMatchObject({ ok: true });

    const resume = await jsonRequest(stack, "/api/v1/admin/resume", "POST");
    expect(resume.status).toBe(200);
    expect(readPauseState(stack.database.db).mode).toBe("running");
    const drillActions = stack.database.db
      .select()
      .from(schema.auditLog)
      .all()
      .map((entry) => entry.action)
      .filter((action) =>
        [
          "system.pause",
          "payout.retry",
          "treasury.reconcile",
          "system.resume",
        ].includes(action),
      );
    expect(drillActions).toEqual([
      "system.pause",
      "payout.retry",
      "treasury.reconcile",
      "system.resume",
    ]);
  });

  it("every_admin_mutation_is_one_command_one_transaction_one_audit_record", async () => {
    const stack = setup();
    const before = { ...stack.coordinator.stats };
    const auditsBefore = stack.database.db
      .select()
      .from(schema.auditLog)
      .all().length;
    await jsonRequest(stack, "/api/v1/admin/pause", "POST", {});
    const commandDelta = stack.coordinator.stats.commands - before.commands;
    const transactionDelta =
      stack.coordinator.stats.transactions - before.transactions;
    const auditDelta =
      stack.database.db.select().from(schema.auditLog).all().length -
      auditsBefore;
    expect({ commandDelta, transactionDelta, auditDelta }).toEqual({
      commandDelta: 1,
      transactionDelta: 1,
      auditDelta: 1,
    });
  });

  it("bonus retry reports the feature disabled/unavailable", async () => {
    const stack = setup();
    const response = await jsonRequest(
      stack,
      "/api/v1/admin/bonuses/alice/retry",
      "POST",
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: "BONUS_UNAVAILABLE",
      hint: expect.stringContaining("Release 4"),
    });
  });
});
