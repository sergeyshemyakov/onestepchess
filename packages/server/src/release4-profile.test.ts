import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRng } from "@onestepchess/core";
import { createMockRail } from "@onestepchess/rail-mock";
import algosdk from "algosdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { genesisForCaip2 } from "./auth/genesis.js";
import { initializeSystemState } from "./boot.js";
import {
  ConfigError,
  loadConfig,
  secretValues,
  serverConfigSchema,
} from "./config.js";
import { ChessAdapterRegistry } from "./coordinator/chess-registry.js";
import {
  type ClaimRecord,
  registerClaimCommands,
} from "./coordinator/claims.js";
import { registerLifecycle } from "./coordinator/lifecycle.js";
import { Coordinator } from "./coordinator/queue.js";
import { TimerService } from "./coordinator/timers.js";
import { CoordinatorViews } from "./coordinator/views.js";
import { type OpenedDatabase, openDatabase, schema } from "./db/open.js";
import { createApp } from "./http/app.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import { registerDiscoveryRoutes } from "./http/routes/discovery.js";
import { securityHeaders } from "./http/static.js";
import { createLogger } from "./logger.js";
import {
  OperationalState,
  probeFacilitator,
  registerOperationalCommands,
} from "./operations/reconciliation.js";
import { createPaymentRail } from "./rail/factory.js";
import { recoverSettlingIntents } from "./recovery.js";

const TESTNET_CAIP2 = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const BASE_URL = "https://osc.example";
const databases: OpenedDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

function database(): OpenedDatabase {
  const opened = openDatabase({ path: ":memory:" });
  databases.push(opened);
  return opened;
}

function avmEnv(account: algosdk.Account) {
  return {
    RAIL: "avm",
    JWT_SECRET: "release-four-jwt-secret-that-is-long-enough",
    TREASURY_MNEMONIC: algosdk.secretKeyToMnemonic(account.sk),
    CAIP2: TESTNET_CAIP2,
    USDC_ASA: "10458941",
    ALGOD_URL: "https://algod.example",
    INDEXER_URL: "https://indexer.example",
    FACILITATOR_URL: "https://facilitator.example",
    EXPLORER_BASE_URL: "https://explorer.example",
  } as const;
}

function supported(caip2: string, feePayer: string): Response {
  return new Response(
    JSON.stringify({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: caip2,
          extra: { feePayer },
        },
      ],
      signers: { "algorand:*": [feePayer] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function recoveryStack(lastValidRound: number | null) {
  const opened = database();
  const config = serverConfigSchema.parse({
    GAME_POOL_TARGET: 1,
    PAYMENT_RECOVERY_TIMEOUT_SECONDS: 2,
    CAIP2: lastValidRound === null ? "mock:local" : TESTNET_CAIP2,
  });
  let now = 1_000_000;
  const rail = createMockRail();
  const views = new CoordinatorViews();
  const coordinator = new Coordinator({
    sqlite: opened.sqlite,
    db: opened.db,
    logger: createLogger({ level: "silent" }),
    now: () => now,
    views,
  });
  const timers = new TimerService({ now: () => now, onFire: () => {} });
  const registry = new ChessAdapterRegistry(4);
  const lifecycle = registerLifecycle({
    coordinator,
    db: opened.db,
    views,
    timers,
    registry,
    config: () => config,
    rng: createRng(2),
    logger: createLogger({ level: "silent" }),
  });
  const deps = {
    coordinator,
    db: opened.db,
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
  opened.db
    .insert(schema.players)
    .values({
      address: "alice",
      kind: "human",
      nickname: "alice",
      createdAt: now,
    })
    .run();
  const seed = async () => {
    await coordinator.dispatch({ type: "PoolTick", payload: {} });
    const requested = await coordinator.dispatch<
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
    await coordinator.dispatch({
      type: "PaymentIntentOpened",
      payload: {
        claimId: claim.id,
        player: "alice",
        move: { uci: "e2e4", san: "e4" },
        clientTxid: "recovery-payment",
        amount: claim.stakeMicrousdc,
        lastValidRound,
      },
    });
    await coordinator.dispatch({
      type: "IntentMarkedSettling",
      payload: { clientTxid: "recovery-payment" },
    });
    return claim;
  };
  return {
    ...deps,
    seed,
    setNow(value: number) {
      now = value;
    },
  };
}

function filesUnder(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const candidate = join(path, entry);
    return statSync(candidate).isDirectory()
      ? filesUnder(candidate)
      : [candidate];
  });
}

describe("Release 4 server profiles and immutable identity (#97)", () => {
  it("server_selects_one_final_payment_rail_from_validated_profile_config", () => {
    const mockLoaded = loadConfig({ env: { RAIL: "mock" } });
    expect(
      createPaymentRail({ env: mockLoaded.env, config: mockLoaded.config })
        .treasuryAddress,
    ).toBe("MOCK_TREASURY");

    const account = algosdk.generateAccount();
    const avmLoaded = loadConfig({ env: avmEnv(account) });
    const rail = createPaymentRail({
      env: avmLoaded.env,
      config: avmLoaded.config,
      fetch: async () => new Response(null, { status: 503 }),
    });
    expect(rail.treasuryAddress).toBe(account.addr.toString());
    expect(() =>
      loadConfig({
        env: { ...avmEnv(account), TREASURY_MNEMONIC: undefined },
      }),
    ).toThrow(ConfigError);
  });

  it("avm_boot_warms_fee_payer_or_persists_only_the_facilitator_pause_cause", async () => {
    const treasury = algosdk.generateAccount();
    const first = algosdk.generateAccount().addr.toString();
    const second = algosdk.generateAccount().addr.toString();
    const loaded = loadConfig({ env: avmEnv(treasury) });
    const responses = [
      supported(TESTNET_CAIP2, first),
      supported(TESTNET_CAIP2, second),
      new Response(null, { status: 503 }),
    ];
    const rail = createPaymentRail({
      env: loaded.env,
      config: loaded.config,
      fetch: async () =>
        responses.shift() ?? new Response(null, { status: 503 }),
    });
    expect(() =>
      rail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: "https://osc.example/api/v1/claims/c/move",
      }),
    ).toThrowError(/successful health probe/);
    expect(await rail.health()).toBe(true);
    expect(
      rail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: "https://osc.example/api/v1/claims/c/move",
      }).required.accepts[0].extra.feePayer,
    ).toBe(first);
    expect(await rail.health()).toBe(true);
    expect(
      rail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: "https://osc.example/api/v1/claims/c/move",
      }).required.accepts[0].extra.feePayer,
    ).toBe(second);
    expect(await rail.health()).toBe(false);
    expect(
      rail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: "https://osc.example/api/v1/claims/c/move",
      }).required.accepts[0].extra.feePayer,
    ).toBe(second);

    const opened = database();
    const mock = createMockRail();
    initializeSystemState({
      db: opened.db,
      railKind: "mock",
      config: serverConfigSchema.parse({}),
      treasuryAddress: mock.treasuryAddress,
      banner: undefined,
      now: 1,
      logger: createLogger({ level: "silent" }),
    });
    const coordinator = new Coordinator({
      sqlite: opened.sqlite,
      db: opened.db,
      logger: createLogger({ level: "silent" }),
    });
    const state = new OperationalState();
    const deps = {
      coordinator,
      db: opened.db,
      rail: mock,
      config: () => serverConfigSchema.parse({}),
      now: () => 2,
      state,
      alerts: { emit: async () => true } as never,
    };
    registerOperationalCommands(deps);
    mock.control.setHealth(false);
    expect(await probeFacilitator(deps)).toBe(false);
    expect(
      JSON.parse(
        opened.db.select().from(schema.systemState).get()?.pauseCausesJson ??
          "[]",
      ),
    ).toEqual(["facilitator"]);
    opened.db
      .update(schema.systemState)
      .set({ pauseCausesJson: '["manual","reconciliation","facilitator"]' })
      .run();
    mock.control.setHealth(true);
    expect(await probeFacilitator(deps)).toBe(true);
    expect(
      JSON.parse(
        opened.db.select().from(schema.systemState).get()?.pauseCausesJson ??
          "[]",
      ),
    ).toEqual(["manual", "reconciliation"]);
  });

  it("server_refuses_nonpristine_database_identity_mismatch_before_recovery", () => {
    const base = serverConfigSchema.parse({});
    const logger = createLogger({ level: "silent" });
    const mutations = [
      { railKind: "avm" as const },
      { config: { ...base, CAIP2: TESTNET_CAIP2 } },
      { config: { ...base, USDC_ASA: "10458941" } },
      { treasuryAddress: "OTHER_TREASURY" },
    ];
    for (const mutation of mutations) {
      const opened = database();
      const options = {
        db: opened.db,
        railKind: "mock" as const,
        config: base,
        treasuryAddress: "MOCK_TREASURY",
        banner: undefined,
        now: 1,
        logger,
      };
      expect(initializeSystemState(options)).toBe(true);
      opened.db
        .insert(schema.ledger)
        .values({
          ts: 1,
          account: "treasury",
          deltaMicrousdc: 1,
          refType: "opening",
          refId: "history",
        })
        .run();
      expect(
        initializeSystemState({ ...options, ...mutation, now: 2 } as never),
      ).toBe(false);
    }

    const pristine = database();
    const options = {
      db: pristine.db,
      railKind: "mock" as const,
      config: base,
      treasuryAddress: "MOCK_TREASURY",
      banner: undefined,
      now: 1,
      logger,
    };
    expect(initializeSystemState(options)).toBe(true);
    expect(
      initializeSystemState({
        ...options,
        config: { ...base, CAIP2: "mock:replacement" },
        now: 2,
      }),
    ).toBe(true);
    expect(pristine.db.select().from(schema.systemState).all()).toHaveLength(1);
  });

  it("avm_move_and_restart_recovery_use_real_rounds_without_swallowing_or_duplicating_payment", async () => {
    const pending = recoveryStack(2_000);
    await pending.seed();
    pending.rail.control.setTxStatus("recovery-payment", { status: "pending" });
    expect(await recoverSettlingIntents(pending)).toBe(pending.now() + 1_000);

    const within = recoveryStack(2_000);
    await within.seed();
    within.rail.control.setTxStatus("recovery-payment", {
      status: "not_found",
      currentRound: 2_000,
    });
    expect(await recoverSettlingIntents(within)).toBe(within.now() + 1_000);

    const expired = recoveryStack(2_000);
    await expired.seed();
    expired.rail.control.setTxStatus("recovery-payment", {
      status: "not_found",
      currentRound: 2_001,
    });
    await recoverSettlingIntents(expired);
    expect(expired.db.select().from(schema.paymentIntents).get()?.status).toBe(
      "failed",
    );

    const confirmed = recoveryStack(2_000);
    const claim = await confirmed.seed();
    confirmed.rail.control.setTxStatus("recovery-payment", {
      status: "confirmed",
      confirmedRound: 1_999,
    });
    await recoverSettlingIntents(confirmed);
    await recoverSettlingIntents(confirmed);
    expect(
      confirmed.db
        .select()
        .from(schema.stakeEntries)
        .where(eq(schema.stakeEntries.claimId, claim.id))
        .all(),
    ).toHaveLength(1);

    const outage = recoveryStack(2_000);
    await outage.seed();
    outage.rail.control.failQueries(["status"]);
    await expect(recoverSettlingIntents(outage)).rejects.toThrow(
      /unavailable/i,
    );
    expect(outage.db.select().from(schema.paymentIntents).get()?.status).toBe(
      "settling",
    );
  });

  it("mock_recovery_behavior_and_all_release3_gates_remain_unchanged", async () => {
    const stack = recoveryStack(null);
    await stack.seed();
    stack.rail.control.setTxStatus("recovery-payment", {
      status: "not_found",
      currentRound: 99_999,
    });
    expect(await recoverSettlingIntents(stack)).toBe(stack.now() + 1_000);
    stack.setNow(stack.now() + 2_000);
    await recoverSettlingIntents(stack);
    expect(stack.db.select().from(schema.paymentIntents).get()?.status).toBe(
      "failed",
    );
  });

  it("meta_auth_csp_and_explorer_values_come_from_one_runtime_network_block", async () => {
    for (const [caip2, asset, algod, explorer] of [
      [
        TESTNET_CAIP2,
        "10458941",
        "https://testnet-algod.example",
        "https://testnet-explorer.example",
      ],
      [
        MAINNET_CAIP2,
        "31566704",
        "https://mainnet-algod.example",
        "https://mainnet-explorer.example",
      ],
    ] as const) {
      const opened = database();
      const config = serverConfigSchema.parse({
        CAIP2: caip2,
        USDC_ASA: asset,
        ALGOD_URL: algod,
        EXPLORER_BASE_URL: explorer,
      });
      const views = new CoordinatorViews();
      const app = createApp({
        logger: createLogger({ level: "silent" }),
        publicBaseUrl: BASE_URL,
        mode: () => "running",
      });
      registerDiscoveryRoutes(app, {
        db: opened.db,
        config: () => config,
        jwtSecret: "release-four-jwt-secret-that-is-long-enough",
        now: () => 1,
        views,
        mode: () => "running",
        rail: { treasuryAddress: "TREASURY" },
        publicBaseUrl: BASE_URL,
      });
      const meta = (await (await app.request("/api/v1/meta")).json()) as {
        network: Record<string, string>;
      };
      expect(meta.network).toMatchObject({
        caip2,
        usdcAssetId: asset,
        algodUrl: algod,
        explorerBaseUrl: explorer,
      });
      expect(genesisForCaip2(caip2).hashB64).toBe(
        caip2.slice("algorand:".length),
      );
      expect(
        securityHeaders({ config, publicBaseUrl: BASE_URL })[
          "Content-Security-Policy"
        ],
      ).toContain(new URL(algod).origin);
    }
    expect(() => genesisForCaip2("algorand:wrong")).toThrow();
    expect(
      serverConfigSchema.safeParse({ ALGOD_URL: "file:///tmp/algod" }).success,
    ).toBe(false);
  });

  it("release4_security_surface_has_only_reviewed_wallet_turnstile_and_algod_origins", async () => {
    const config = serverConfigSchema.parse({
      CAIP2: MAINNET_CAIP2,
      ALGOD_URL: "https://mainnet-api.4160.nodely.dev",
      WALLETCONNECT_RELAY_URL: "wss://relay.walletconnect.org",
    });
    const headers = securityHeaders({
      config,
      publicBaseUrl: "https://osc.example",
    });
    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");

    const csp = headers["Content-Security-Policy"] ?? "";
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "script-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "img-src 'self' data: blob:",
      "style-src 'self'",
      "font-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain("*");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");

    const walletMatrix = [
      {
        wallet: "Pera",
        origins: [
          "https://wc.perawallet.app",
          "https://wallet-connect-a.perawallet.app",
          "wss://wallet-connect-a.perawallet.app",
        ],
      },
      { wallet: "Defly", origins: ["https://static.defly.app"] },
      { wallet: "Lute", origins: [] },
    ];
    expect(walletMatrix.map(({ wallet }) => wallet)).toEqual([
      "Pera",
      "Defly",
      "Lute",
    ]);
    for (const { origins } of walletMatrix) {
      for (const origin of origins) expect(csp).toContain(origin);
    }
    for (const origin of [
      "https://mainnet-api.4160.nodely.dev",
      "wss://relay.walletconnect.org",
      "https://challenges.cloudflare.com",
      "https://bridge.walletconnect.org",
      "wss://bridge.walletconnect.org",
    ]) {
      expect(csp).toContain(origin);
    }
    expect(csp).not.toContain("testnet-api.4160.nodely.dev");

    const app = createApp({ logger: createLogger({ level: "silent" }) });
    const crossOrigin = await app.request("/missing", {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("server_logs_openapi_admin_and_static_assets_are_free_of_secrets_and_profile_leakage", () => {
    const secret = "release-four-secret-sentinel-never-emit";
    const chunks: string[] = [];
    const logger = createLogger({
      secrets: [secret],
      destination: { write: (chunk) => chunks.push(chunk) },
    });
    logger.info({ nested: secret }, `boot ${secret}`);
    const openapi = JSON.stringify(
      buildOpenApiDocument({ publicBaseUrl: BASE_URL }),
    );
    const webFiles = filesUnder("packages/web/src").filter(
      (path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"),
    );
    const assets = webFiles
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const loaded = loadConfig({ env: { RAIL: "mock", JWT_SECRET: secret } });
    expect(secretValues(loaded.env)).toContain(secret);
    expect(chunks.join("")).not.toContain(secret);
    expect(openapi).not.toContain(secret);
    expect(assets).not.toContain(secret);
    expect(assets).not.toContain("TREASURY_MNEMONIC");
  });

  it("testnet_and_mainnet_profiles_cannot_share_a_database_path_in_documented_deployment_config", () => {
    const profiles = ["mock", "testnet", "mainnet"].map((name) =>
      readFileSync(`deploy/profiles/${name}.env.example`, "utf8"),
    );
    const paths = profiles.map(
      (profile) => /^DB_PATH=(.+)$/m.exec(profile)?.[1] ?? "",
    );
    expect(new Set(paths).size).toBe(3);
    expect(
      paths.every((path) => path.startsWith("/data/") && path.length > 6),
    ).toBe(true);
    expect(readFileSync("package.json", "utf8")).toContain(
      '"dev:testnet": "node --env-file=.env.testnet --run dev"',
    );
    expect(readFileSync(".gitignore", "utf8")).toContain(".env.*");
  });
});
