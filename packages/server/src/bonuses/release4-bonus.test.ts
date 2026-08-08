import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockRail } from "@onestepchess/rail-mock";
import algosdk from "algosdk";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../auth/jwt.js";
import { serverConfigSchema } from "../config.js";
import { Coordinator } from "../coordinator/queue.js";
import { type OpenedDatabase, openDatabase, schema } from "../db/open.js";
import { createApp } from "../http/app.js";
import { buildOpenApiDocument } from "../http/openapi.js";
import {
  type HumanRouteDeps,
  registerHumanRoutes,
} from "../http/routes/human.js";
import { createLogger } from "../logger.js";
import {
  bonusProfileStatus,
  evaluateBonusEligibility,
  registerBonusCommands,
} from "./lifecycle.js";
import { registerBonusRoutes } from "./routes.js";
import { runBonusWatcher } from "./watcher.js";

const JWT_SECRET = "release-four-bonus-test-secret-long-enough";
const BASE_URL = "https://osc.example";
const MAINNET_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const databases: OpenedDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
});

function setup(overrides: Record<string, unknown> = {}) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  let now = Date.UTC(2026, 6, 31, 12);
  let config = serverConfigSchema.parse({
    BONUS_DAILY_CAP: 2,
    BONUS_ALGO_MICRO: 250_000,
    BONUS_USDC_MICRO: 200_000,
    ...overrides,
  });
  const rail = createMockRail();
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    now: () => now,
  });
  const deps: HumanRouteDeps = {
    coordinator,
    db: database.db,
    rail,
    config: () => config,
    jwtSecret: JWT_SECRET,
    publicBaseUrl: BASE_URL,
    trustProxyHops: 1,
    now: () => now,
    rng: () => 0.5,
  };
  registerBonusCommands({ coordinator, db: database.db, config: () => config });
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl: BASE_URL,
    mode: () => "running",
  });
  registerHumanRoutes(app, deps);
  registerBonusRoutes(app, deps);
  return {
    app,
    database,
    coordinator,
    deps,
    rail,
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

function seedPlayer(
  stack: Stack,
  account: algosdk.Account,
  kind: "human" | "agent" | "guest" = "human",
): void {
  stack.database.db
    .insert(schema.players)
    .values({
      address: account.addr.toString(),
      kind,
      nickname: kind === "guest" ? null : account.addr.toString().slice(0, 8),
      createdAt: stack.now(),
    })
    .run();
}

let gameCounter = 0;
function seedDemo(
  stack: Stack,
  player: string,
  status: "open" | "moved" | "expired" = "moved",
): void {
  gameCounter += 1;
  const gameId = `gm_bonus_${gameCounter}`;
  stack.database.db
    .insert(schema.games)
    .values({
      id: gameId,
      name: `bonus-game-${gameCounter}`,
      status: "active",
      fen: "fen",
      rulesJson: "{}",
      lastPlyAt: stack.now(),
      createdAt: stack.now(),
    })
    .run();
  stack.database.db
    .insert(schema.claims)
    .values({
      id: `clm_bonus_${gameCounter}`,
      gameId,
      player,
      side: "white",
      demo: true,
      stakeMicrousdc: 0,
      status,
      createdAt: stack.now(),
      deadline: stack.now() + 60_000,
      ...(status === "moved"
        ? {
            movedAt: stack.now(),
            movedPly: 1,
            moveUci: "e2e4",
            moveSan: "e4",
            fenBefore: "before",
            fenAfter: "after",
          }
        : {}),
    })
    .run();
}

function authorization(
  stack: Stack,
  account: algosdk.Account,
  kind: "human" | "agent" = "human",
): Record<string, string> {
  const nowSeconds = Math.floor(stack.now() / 1_000);
  return {
    authorization: `Bearer ${signSession(JWT_SECRET, {
      sub: account.addr.toString(),
      kind,
      jti: `jti-${account.addr.toString()}`,
      iat: nowSeconds,
      exp: nowSeconds + 3_600,
    })}`,
  };
}

type OptInTweaks = {
  readonly sender?: algosdk.Account;
  readonly receiver?: string;
  readonly amount?: number;
  readonly assetIndex?: number;
  readonly fee?: number;
  readonly lastValid?: number;
  readonly genesisHash?: string;
  readonly note?: Uint8Array;
  readonly lease?: Uint8Array;
  readonly rekeyTo?: string;
  readonly closeRemainderTo?: string;
  readonly assetSender?: string;
  readonly group?: boolean;
};

function signedOptIn(
  account: algosdk.Account,
  tweaks: OptInTweaks = {},
): string {
  const sender = tweaks.sender ?? account;
  const transaction = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
    {
      sender: sender.addr,
      receiver: tweaks.receiver ?? account.addr,
      amount: tweaks.amount ?? 0,
      assetIndex: tweaks.assetIndex ?? 31_566_704,
      ...(tweaks.note === undefined ? {} : { note: tweaks.note }),
      ...(tweaks.lease === undefined ? {} : { lease: tweaks.lease }),
      ...(tweaks.rekeyTo === undefined ? {} : { rekeyTo: tweaks.rekeyTo }),
      ...(tweaks.closeRemainderTo === undefined
        ? {}
        : { closeRemainderTo: tweaks.closeRemainderTo }),
      ...(tweaks.assetSender === undefined
        ? {}
        : { assetSender: tweaks.assetSender }),
      suggestedParams: {
        flatFee: true,
        fee: tweaks.fee ?? 1_000,
        minFee: 1_000,
        firstValid: 10_000,
        lastValid: tweaks.lastValid ?? 11_000,
        genesisID: "mainnet-v1.0",
        genesisHash: new Uint8Array(
          Buffer.from(tweaks.genesisHash ?? MAINNET_HASH, "base64"),
        ),
      },
    },
  );
  if (tweaks.group === true) algosdk.assignGroupID([transaction]);
  return Buffer.from(transaction.signTxn(sender.sk)).toString("base64");
}

function seedClaimedBonus(stack: Stack, account: algosdk.Account): void {
  stack.database.db
    .insert(schema.bonuses)
    .values({
      player: account.addr.toString(),
      status: "claimed",
      algoAmount: 250_000,
      usdcAmount: 200_000,
      claimIp: "203.0.113.1",
      claimedAt: stack.now(),
    })
    .run();
}

describe("Release 4 starter-stake claim and opt-in (#98)", () => {
  it("release4_bonus_schema_upgrades_empty_and_release3_databases_without_changing_existing_rows", () => {
    const migrationsSource = fileURLToPath(
      new URL("../../drizzle", import.meta.url),
    );
    const dir = mkdtempSync(join(tmpdir(), "osc-r4-bonus-"));
    const migrations = join(dir, "migrations");
    mkdirSync(join(migrations, "meta"), { recursive: true });
    for (const name of [
      "0000_init.sql",
      "0001_release2_human_reads.sql",
      "0002_release2_incentives.sql",
      "0003_ongoing_move_position.sql",
    ]) {
      copyFileSync(join(migrationsSource, name), join(migrations, name));
    }
    const journal = JSON.parse(
      readFileSync(join(migrationsSource, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 3);
    writeFileSync(
      join(migrations, "meta", "_journal.json"),
      JSON.stringify(journal),
    );
    const path = join(dir, "release3.sqlite");
    const release3 = new Database(path);
    migrate(drizzle(release3), { migrationsFolder: migrations });
    release3
      .prepare(
        "INSERT INTO players (address, kind, nickname, created_at) VALUES ('alice', 'human', 'alice', 1)",
      )
      .run();
    release3.close();

    const upgraded = openDatabase({ path });
    databases.push(upgraded);
    expect(
      upgraded.sqlite.prepare("SELECT * FROM players").all(),
    ).toMatchObject([{ address: "alice", kind: "human", nickname: "alice" }]);
    const tables = upgraded.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["bonuses", "funding_jobs"]));
    const indexes = upgraded.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining(["bonuses_claimed_at", "funding_jobs_player_leg"]),
    );
    expect(() =>
      upgraded.sqlite
        .prepare(
          "INSERT INTO bonuses (player, status, algo_amount, usdc_amount, claim_ip, claimed_at) VALUES ('alice', 'claimed', 0, 1, 'ip', 1)",
        )
        .run(),
    ).toThrow();
  });

  it("starter_stake_eligibility_requires_one_moved_demo_and_is_one_per_human_forever", () => {
    const base = {
      kind: "human" as const,
      movedDemo: true,
      alreadyClaimed: false,
      enabled: true,
      claimedToday: 0,
      dailyCap: 1,
    };
    expect(evaluateBonusEligibility(base)).toEqual({ eligible: true });
    for (const facts of [
      { ...base, movedDemo: false },
      { ...base, alreadyClaimed: true },
      { ...base, enabled: false },
      { ...base, kind: "agent" as const },
    ]) {
      expect(evaluateBonusEligibility(facts).eligible).toBe(false);
    }

    const stack = setup();
    const human = algosdk.generateAccount();
    seedPlayer(stack, human);
    seedDemo(stack, human.addr.toString(), "open");
    seedDemo(stack, human.addr.toString(), "expired");
    expect(
      bonusProfileStatus(stack.deps, human.addr.toString(), stack.now()),
    ).toBeNull();
    seedDemo(stack, human.addr.toString(), "moved");
    expect(
      bonusProfileStatus(stack.deps, human.addr.toString(), stack.now()),
    ).toEqual({
      status: "available",
    });
    const guest = algosdk.generateAccount();
    seedPlayer(stack, guest, "guest");
    seedDemo(stack, guest.addr.toString(), "moved");
    stack.database.db
      .update(schema.claims)
      .set({ player: human.addr.toString() })
      .where(eq(schema.claims.player, guest.addr.toString()))
      .run();
    expect(
      bonusProfileStatus(stack.deps, human.addr.toString(), stack.now()),
    ).toEqual({
      status: "available",
    });
  });

  it("starter_stake_daily_cap_is_serialized_across_concurrent_claims_at_utc_midnight", async () => {
    const stack = setup({ BONUS_DAILY_CAP: 1 });
    stack.setNow(Date.UTC(2026, 6, 31, 23, 59, 59));
    const first = algosdk.generateAccount();
    const second = algosdk.generateAccount();
    for (const account of [first, second]) {
      seedPlayer(stack, account);
      seedDemo(stack, account.addr.toString());
    }
    const results = await Promise.all(
      [first, second].map((account, index) =>
        stack.coordinator.dispatch<
          { player: string; claimIp: string },
          { status: string; retryAfterSeconds?: number }
        >({
          type: "BonusClaimed",
          payload: {
            player: account.addr.toString(),
            claimIp: `203.0.113.${index + 1}`,
          },
        }),
      ),
    );
    expect(stack.database.db.select().from(schema.bonuses).all()).toHaveLength(
      1,
    );
    expect(
      results.map((result) =>
        result.kind === "ok" ? result.result.status : "deprioritized",
      ),
    ).toEqual(expect.arrayContaining(["claimed", "unavailable"]));
    expect(
      results.find(
        (result) =>
          result.kind === "ok" && result.result.status === "unavailable",
      ),
    ).toMatchObject({ kind: "ok", result: { retryAfterSeconds: 1 } });
    const firstRow = stack.database.db.select().from(schema.bonuses).get();
    expect(firstRow).toMatchObject({
      algoAmount: 250_000,
      usdcAmount: 200_000,
      claimIp: expect.stringMatching(/^203\.0\.113\./),
    });
    stack.setConfig({ BONUS_ALGO_MICRO: 999_999, BONUS_USDC_MICRO: 888_888 });
    expect(stack.database.db.select().from(schema.bonuses).get()).toMatchObject(
      {
        algoAmount: 250_000,
        usdcAmount: 200_000,
      },
    );
  });

  it("profile_and_bonus_claim_routes_project_every_pinned_status_and_error", async () => {
    const stack = setup();
    const human = algosdk.generateAccount();
    const ineligible = algosdk.generateAccount();
    const agent = algosdk.generateAccount();
    seedPlayer(stack, human);
    seedPlayer(stack, ineligible);
    seedPlayer(stack, agent, "agent");
    seedDemo(stack, human.addr.toString());
    stack.rail.control.setAccountInfo(human.addr.toString(), {
      optedInUsdc: false,
    });
    const humanHeaders = authorization(stack, human);
    const available = await stack.app.request("/api/v1/my/profile", {
      headers: humanHeaders,
    });
    expect(await available.json()).toMatchObject({
      bonus: { status: "available" },
    });
    const absent = await stack.app.request("/api/v1/my/profile", {
      headers: authorization(stack, ineligible),
    });
    expect((await absent.json()) as Record<string, unknown>).not.toHaveProperty(
      "bonus",
    );
    const claimed = await stack.app.request("/api/v1/my/bonus/claim", {
      method: "POST",
      headers: { ...humanHeaders, "x-forwarded-for": "198.51.100.7" },
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      bonus: { status: "claimed" },
    });
    stack.database.db
      .update(schema.bonuses)
      .set({ algoTxid: "ALGO_CONFIRMATION_TX" })
      .where(eq(schema.bonuses.player, human.addr.toString()))
      .run();
    stack.setConfig({ BONUS_ENABLED: false });
    const cold = await stack.app.request("/api/v1/my/profile", {
      headers: humanHeaders,
    });
    expect(await cold.json()).toMatchObject({
      bonus: { status: "claimed", algoTxid: "ALGO_CONFIRMATION_TX" },
    });
    const disabled = await stack.app.request("/api/v1/my/bonus/claim", {
      method: "POST",
      headers: authorization(stack, ineligible),
    });
    expect(disabled.status).toBe(403);
    const agentResponse = await stack.app.request("/api/v1/my/bonus/claim", {
      method: "POST",
      headers: authorization(stack, agent, "agent"),
    });
    expect(agentResponse.status).toBe(403);
    const document = buildOpenApiDocument({ publicBaseUrl: BASE_URL }) as {
      paths: Record<string, unknown>;
    };
    expect(document.paths).toHaveProperty("/api/v1/my/bonus/claim");
    expect(document.paths).toHaveProperty("/api/v1/my/bonus/optin-txn");
    expect(document.paths).toHaveProperty("/api/v1/my/bonus/optin");
  });

  it("welcome_stake_stays_offered_when_USDC_is_sufficient_but_ALGO_is_not", async () => {
    const stack = setup();
    const usdcRich = algosdk.generateAccount();
    seedPlayer(stack, usdcRich);
    seedDemo(stack, usdcRich.addr.toString());
    stack.rail.control.setBalances(usdcRich.addr.toString(), {
      usdcMicroUsdc: 500_000,
      algoMicroAlgo: 0,
    });
    stack.rail.control.setAccountInfo(usdcRich.addr.toString(), {
      optedInUsdc: true,
    });

    const profile = (await (
      await stack.app.request("/api/v1/my/profile", {
        headers: authorization(stack, usdcRich),
      })
    ).json()) as Record<string, unknown>;
    expect(profile).toMatchObject({ bonus: { status: "available" } });
    const claimed = await stack.app.request("/api/v1/my/bonus/claim", {
      method: "POST",
      headers: authorization(stack, usdcRich),
    });
    expect(claimed.status).toBe(200);
  });

  it("welcome_stake_skips_wallets_with_sufficient_USDC_and_ALGO_and_advances_already_opted_in_wallets", async () => {
    const stack = setup();
    const sufficient = algosdk.generateAccount();
    seedPlayer(stack, sufficient);
    seedDemo(stack, sufficient.addr.toString());
    stack.rail.control.setBalances(sufficient.addr.toString(), {
      usdcMicroUsdc: 500_000,
      algoMicroAlgo: 500_000,
    });

    const profile = (await (
      await stack.app.request("/api/v1/my/profile", {
        headers: authorization(stack, sufficient),
      })
    ).json()) as Record<string, unknown>;
    expect(profile).not.toHaveProperty("bonus");
    const rejected = await stack.app.request("/api/v1/my/bonus/claim", {
      method: "POST",
      headers: authorization(stack, sufficient),
    });
    expect(rejected.status).toBe(403);
    expect(stack.database.db.select().from(schema.bonuses).all()).toHaveLength(
      0,
    );

    const optedIn = algosdk.generateAccount();
    seedPlayer(stack, optedIn);
    seedDemo(stack, optedIn.addr.toString());
    stack.rail.control.setAccountInfo(optedIn.addr.toString(), {
      optedInUsdc: true,
    });
    const claimed = await stack.app.request("/api/v1/my/bonus/claim", {
      method: "POST",
      headers: authorization(stack, optedIn),
    });
    expect(claimed.status).toBe(200);
    expect(
      stack.database.db
        .select({ status: schema.bonuses.status })
        .from(schema.bonuses)
        .where(eq(schema.bonuses.player, optedIn.addr.toString()))
        .get(),
    ).toEqual({ status: "opted_in" });
  });

  it("welcome_stake_rejects_a_fresh_wallet_before_claim_when_starter_ALGO_cannot_preserve_the_treasury_floor", async () => {
    const stack = setup();
    const fresh = algosdk.generateAccount();
    seedPlayer(stack, fresh);
    seedDemo(stack, fresh.addr.toString());
    stack.rail.control.setBalances(fresh.addr.toString(), {
      usdcMicroUsdc: 0,
      algoMicroAlgo: 0,
    });
    stack.rail.control.setAccountInfo(fresh.addr.toString(), {
      optedInUsdc: false,
    });
    stack.rail.control.setBalances(stack.rail.treasuryAddress, {
      algoMicroAlgo: 1_250_999,
    });

    const response = await stack.app.request("/api/v1/my/bonus/claim", {
      method: "POST",
      headers: authorization(stack, fresh),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: "BONUS_UNAVAILABLE",
      hint: "starter ALGO is temporarily unavailable — try again shortly",
    });
    expect(stack.database.db.select().from(schema.bonuses).all()).toHaveLength(
      0,
    );
  });

  it("welcome_stake_initial_profile_marks_an_existing_half_ALGO_as_ready", async () => {
    const stack = setup();
    const ready = algosdk.generateAccount();
    seedPlayer(stack, ready);
    seedDemo(stack, ready.addr.toString());
    stack.rail.control.setBalances(ready.addr.toString(), {
      usdcMicroUsdc: 0,
      algoMicroAlgo: 500_000,
    });
    stack.rail.control.setAccountInfo(ready.addr.toString(), {
      optedInUsdc: false,
    });

    const claim = await stack.app.request("/api/v1/my/bonus/claim", {
      method: "POST",
      headers: authorization(stack, ready),
    });
    expect(claim.status).toBe(200);
    const profile = await stack.app.request("/api/v1/my/profile", {
      headers: authorization(stack, ready),
    });

    expect(await profile.json()).toMatchObject({
      bonus: { status: "claimed", algoReady: true },
    });
  });

  it("bonus_optin_guard_rejects_every_unsafe_transaction_before_relay", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    const other = algosdk.generateAccount();
    seedPlayer(stack, account);
    seedClaimedBonus(stack, account);
    const relay = vi.spyOn(stack.rail, "submitSignedTransaction");
    const mutations: OptInTweaks[] = [
      { sender: other },
      { receiver: other.addr.toString() },
      { amount: 1 },
      { assetIndex: 1 },
      { genesisHash: Buffer.alloc(32, 7).toString("base64") },
      { fee: 2_000 },
      { lastValid: 11_001 },
      { group: true },
      { lease: new Uint8Array(32).fill(1) },
      { note: new TextEncoder().encode("unsafe") },
      { rekeyTo: other.addr.toString() },
      { closeRemainderTo: other.addr.toString() },
      { assetSender: other.addr.toString() },
    ];
    for (const tweaks of mutations) {
      const response = await stack.app.request("/api/v1/my/bonus/optin", {
        method: "POST",
        headers: {
          ...authorization(stack, account),
          "content-type": "application/json",
        },
        body: JSON.stringify({ signedTxnB64: signedOptIn(account, tweaks) }),
      });
      expect(response.status, JSON.stringify(tweaks)).toBe(400);
    }
    expect(relay).not.toHaveBeenCalled();
  });

  it("bonus_optin_relay_treats_accept_or_ambiguity_as_watchable_and_definite_rejection_as_invalid", async () => {
    const stack = setup();
    const account = algosdk.generateAccount();
    seedPlayer(stack, account);
    seedClaimedBonus(stack, account);
    const request = () =>
      stack.app.request("/api/v1/my/bonus/optin", {
        method: "POST",
        headers: {
          ...authorization(stack, account),
          "content-type": "application/json",
        },
        body: JSON.stringify({ signedTxnB64: signedOptIn(account) }),
      });
    expect((await request()).status).toBe(202);
    stack.rail.control.queueSubmitSignedTransaction({
      ok: false,
      reason: "unavailable",
      applied: true,
    });
    expect((await request()).status).toBe(202);
    stack.rail.control.queueSubmitSignedTransaction({
      ok: false,
      reason: "rejected",
      detail: "rejected safely",
    });
    const rejected = await request();
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "OPTIN_INVALID" });
  });

  it("bonus_watcher_advances_each_row_once_for_relayed_or_wallet_native_optin", async () => {
    const stack = setup();
    const relayed = algosdk.generateAccount();
    const walletNative = algosdk.generateAccount();
    for (const account of [relayed, walletNative]) {
      seedPlayer(stack, account);
      seedClaimedBonus(stack, account);
      stack.rail.control.setAccountInfo(account.addr.toString(), {
        optedInUsdc: false,
      });
    }
    stack.rail.control.failQueries(["account"]);
    expect(await runBonusWatcher(stack.deps)).toBe(0);
    stack.rail.control.restoreQueries();
    await stack.app.request("/api/v1/my/bonus/optin", {
      method: "POST",
      headers: {
        ...authorization(stack, relayed),
        "content-type": "application/json",
      },
      body: JSON.stringify({ signedTxnB64: signedOptIn(relayed) }),
    });
    stack.rail.control.setAccountInfo(walletNative.addr.toString(), {
      optedInUsdc: true,
    });
    stack.setConfig({ BONUS_ENABLED: false });
    expect(await runBonusWatcher(stack.deps)).toBe(2);
    expect(await runBonusWatcher(stack.deps)).toBe(0);
    expect(
      stack.database.db
        .select()
        .from(schema.events)
        .all()
        .filter((event) => event.type === "bonus_updated"),
    ).toHaveLength(2);
  });

  it("bonus_profile_and_event_surfaces_never_reach_agents_or_guest_sessions", async () => {
    const stack = setup();
    const human = algosdk.generateAccount();
    const agent = algosdk.generateAccount();
    const guest = algosdk.generateAccount();
    seedPlayer(stack, human);
    seedPlayer(stack, agent, "agent");
    seedPlayer(stack, guest, "guest");
    seedDemo(stack, human.addr.toString());
    await stack.coordinator.dispatch({
      type: "BonusClaimed",
      payload: { player: human.addr.toString(), claimIp: "203.0.113.9" },
    });
    const agentProfile = await stack.app.request("/api/v1/my/profile", {
      headers: authorization(stack, agent, "agent"),
    });
    expect(
      (await agentProfile.json()) as Record<string, unknown>,
    ).not.toHaveProperty("bonus");
    const guestProfile = await stack.app.request("/api/v1/my/profile");
    expect(guestProfile.status).toBe(401);
    const bonusEvents = stack.database.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, "bonus_updated"))
      .all();
    expect(bonusEvents).toHaveLength(1);
    expect(bonusEvents[0]?.player).toBe(human.addr.toString());
  });
});
