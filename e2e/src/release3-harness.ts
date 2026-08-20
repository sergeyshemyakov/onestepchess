import {
  checkDomainInvariants,
  createRng,
  type DomainSnapshot,
  gameRulesSchema,
} from "@onestepchess/core";
import {
  createMockRail,
  type MockRail,
  type MockRailState,
} from "@onestepchess/rail-mock";
import {
  ChessAdapterRegistry,
  Coordinator,
  CoordinatorViews,
  createApp,
  createLogger,
  currentMode,
  EventStreamService,
  initializeSystemState,
  type OpenedDatabase,
  OperationalAlerts,
  OperationalState,
  openDatabase,
  probeFacilitator,
  recoverSettlingIntents,
  registerAuthRoutes,
  registerClaimCommands,
  registerClaimRoutes,
  registerDiscoveryRoutes,
  registerEventRoutes,
  registerHumanCommands,
  registerHumanRoutes,
  registerLifecycle,
  registerOpenApiRoute,
  registerOperationalCommands,
  registerPayoutCommands,
  registerResolution,
  runPayoutExecutor,
  runReconciliation,
  type ServerConfig,
  schema,
  serverConfigSchema,
  TimerService,
} from "@onestepchess/server";
import type { PublicFetch } from "./public-driver.js";

const DEFAULT_NOW = Date.UTC(2026, 6, 26, 12);
const DEFAULT_BASE_URL = "https://release3-e2e.example";
const JWT_SECRET = "release-three-e2e-secret-0123456789";

export type Release3Harness = Awaited<ReturnType<typeof createRelease3Harness>>;

export type Release3HarnessOptions = {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly databasePath?: string;
  readonly initialTreasuryMicroUsdc?: number;
  readonly railState?: MockRailState;
  readonly baseUrl?: string;
  readonly now?: number;
  readonly captureLogs?: boolean;
};

export async function createRelease3Harness(
  options: Release3HarnessOptions = {},
) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const database = openDatabase({ path: options.databasePath ?? ":memory:" });
  const config: ServerConfig = serverConfigSchema.parse({
    GAME_POOL_TARGET: 1,
    MIN_PLY_INTERVAL_SECONDS: 1,
    COOLDOWN_PLIES: 5,
    QUOTA_AGENT: 1_000,
    RATE_LIMIT_AUTH_PER_IP_MIN: 10_000,
    RATE_LIMIT_CLAIMS_PER_IP_MIN: 100_000,
    HUMAN_BOARD_RESERVE_PERCENT: 0,
    PUBLIC_STATS_ENABLED: false,
    ...options.config,
  });
  let now = options.now ?? DEFAULT_NOW;
  const logLines: string[] = [];
  const logStats = {
    structured: 0,
    malformed: 0,
    secretFindings: 0,
  };
  const commandDurationsMs: number[] = [];
  const moveCommandDurationsMs: number[] = [];
  const logger = createLogger(
    options.captureLogs
      ? {
          level: "info",
          destination: {
            write(chunk) {
              if (logLines.length < 256) logLines.push(chunk);
              if (
                [
                  "TREASURY_MNEMONIC",
                  "JWT_SECRET",
                  "ADMIN_TOKEN",
                  "TURNSTILE_SECRET",
                  "PAYMENT-SIGNATURE",
                  JWT_SECRET,
                ].some((value) => chunk.includes(value))
              ) {
                logStats.secretFindings += 1;
              }
              try {
                const parsed = JSON.parse(chunk) as {
                  readonly msg?: string;
                  readonly command?: string;
                  readonly durationMs?: number;
                };
                logStats.structured += 1;
                if (
                  parsed.msg === "command" &&
                  typeof parsed.durationMs === "number"
                ) {
                  commandDurationsMs.push(parsed.durationMs);
                  if (parsed.command === "MoveSettled") {
                    moveCommandDurationsMs.push(parsed.durationMs);
                  }
                }
              } catch {
                logStats.malformed += 1;
              }
            },
          },
        }
      : { level: "silent" },
  );
  const rail: MockRail = createMockRail({
    initialTreasury: {
      usdcMicroUsdc: options.initialTreasuryMicroUsdc ?? 10_000_000,
      algoMicroAlgo: 10_000_000,
    },
    now: () => now,
    ...(options.railState === undefined ? {} : { state: options.railState }),
  });
  if (
    !initializeSystemState({
      db: database.db,
      railKind: "mock",
      config,
      treasuryAddress: rail.treasuryAddress,
      banner: undefined,
      now,
      logger,
    })
  ) {
    throw new Error("release3 harness rail identity mismatch");
  }

  const views = new CoordinatorViews();
  views.rebuild(database.db, now);
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger,
    now: () => now,
    views,
  });
  const alerts = new OperationalAlerts({
    url: undefined,
    dedupeSeconds: () => config.ALERT_DEDUPE_SECONDS,
    now: () => now,
    transport: async () => ({}),
    logger,
  });
  const operationalState = new OperationalState();
  const operationalDeps = {
    coordinator,
    db: database.db,
    rail,
    config: () => config,
    now: () => now,
    alerts,
    state: operationalState,
  };
  registerOperationalCommands(operationalDeps);
  await runReconciliation(operationalDeps, "boot");
  await coordinator.onIdle();
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
  const registry = new ChessAdapterRegistry(2 * config.GAME_POOL_TARGET + 8);
  const lifecycle = registerLifecycle({
    coordinator,
    db: database.db,
    views,
    timers,
    registry,
    config: () => config,
    rng: createRng(7_401),
    logger,
  });
  const claimDeps = {
    coordinator,
    db: database.db,
    views,
    timers,
    registry,
    lifecycle,
    config: () => config,
    rail,
    now: () => now,
    rng: createRng(7_402),
    jwtSecret: JWT_SECRET,
    trustProxyHops: 1,
    publicBaseUrl: baseUrl,
    mode: () => currentMode(database.db),
    turnstile: async () => "pass" as const,
  };
  registerClaimCommands(claimDeps);
  registerResolution({
    coordinator,
    db: database.db,
    logger,
    config: () => config,
  });
  const payoutDeps = {
    coordinator,
    db: database.db,
    rail,
    config: () => config,
    now: () => now,
    logger,
  };
  registerPayoutCommands(payoutDeps);

  const events = new EventStreamService({
    sqlite: database.sqlite,
    db: database.db,
    config: () => config,
    now: () => now,
    logger,
  });
  const unsubscribeEvents = coordinator.onEvent((event) => {
    events.publish(event);
  });

  const app = createApp({
    logger,
    publicBaseUrl: baseUrl,
    mode: claimDeps.mode,
  });
  const authDeps = {
    db: database.db,
    rail,
    config: () => config,
    publicBaseUrl: baseUrl,
    jwtSecret: JWT_SECRET,
    trustProxyHops: 1,
    turnstile: async () => "pass" as const,
    now: () => now,
    rng: createRng(7_403),
    coordinator,
  };
  registerAuthRoutes(app, authDeps);
  registerClaimRoutes(app, claimDeps);
  const humanDeps = {
    db: database.db,
    coordinator,
    rail,
    config: () => config,
    jwtSecret: JWT_SECRET,
    publicBaseUrl: baseUrl,
    trustProxyHops: 1,
    now: () => now,
    rng: createRng(7_404),
  };
  registerHumanCommands(humanDeps);
  registerHumanRoutes(app, humanDeps);
  registerEventRoutes(app, { ...authDeps, events });
  registerDiscoveryRoutes(app, {
    db: database.db,
    config: () => config,
    jwtSecret: JWT_SECRET,
    now: () => now,
    views,
    mode: claimDeps.mode,
    rail,
    publicBaseUrl: baseUrl,
  });
  registerOpenApiRoute(app, { publicBaseUrl: baseUrl });

  await coordinator.dispatch({ type: "PoolTick", payload: {} });

  const fetchFor = (ip: string): PublicFetch => {
    const fetch: PublicFetch = async (input, init) => {
      const incoming = new Request(input, init);
      const headers = new Headers(incoming.headers);
      headers.set("x-forwarded-for", ip);
      // Types-only cast: the ambient DOM Request and @types/node's undici
      // Request drift apart across @types/node versions; both are the same
      // runtime object.
      return app.fetch(
        new Request(incoming, { headers }) as unknown as Parameters<
          typeof app.fetch
        >[0],
      );
    };
    return fetch;
  };

  const snapshot = (): DomainSnapshot => mapDomainSnapshot(database, config);

  return Object.freeze({
    app,
    baseUrl,
    config,
    commandDurationsMs,
    coordinator,
    database,
    events,
    fetchFor,
    rail,
    logLines,
    logStats,
    moveCommandDurationsMs,
    timers,
    now: () => now,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    advancePacing() {
      now += config.MIN_PLY_INTERVAL_SECONDS * 1_000;
    },
    async poolTick() {
      await coordinator.dispatch({ type: "PoolTick", payload: {} });
      await coordinator.onIdle();
    },
    async runPayouts() {
      await coordinator.onIdle();
      await runPayoutExecutor(payoutDeps);
      await coordinator.onIdle();
    },
    async recoverPayments() {
      const nextAt = await recoverSettlingIntents(claimDeps);
      await coordinator.onIdle();
      return nextAt;
    },
    async probeFacilitator() {
      await probeFacilitator(operationalDeps);
      await coordinator.onIdle();
      return currentMode(database.db);
    },
    async reconcile(source: "boot" | "scheduled" | "admin" = "admin") {
      const report = await runReconciliation(operationalDeps, source);
      await coordinator.onIdle();
      return report;
    },
    snapshot,
    invariantViolations() {
      return checkDomainInvariants(snapshot(), { verifyFens: true });
    },
    close() {
      timers.disarmAll();
      unsubscribeEvents();
      events.closeAll();
      database.sqlite.close();
    },
  });
}

export function mapDomainSnapshot(
  database: OpenedDatabase,
  config: ServerConfig,
): DomainSnapshot {
  return {
    cfg: config,
    games: database.db
      .select()
      .from(schema.games)
      .all()
      .map((game) => ({
        id: game.id,
        status: game.status,
        fen: game.fen,
        ply: game.ply,
        rules: gameRulesSchema.parse(JSON.parse(game.rulesJson)),
        history: JSON.parse(game.historyJson) as string[],
        result: game.result,
        termination: game.termination,
        endspielPly: game.endspielPly,
        minNextClaimAt: game.minNextClaimAt,
        lastPlyAt: game.lastPlyAt,
        resolvedAt: game.resolvedAt,
      })),
    claims: database.db
      .select()
      .from(schema.claims)
      .all()
      .map((claim) => ({
        id: claim.id,
        gameId: claim.gameId,
        player: claim.player,
        side: claim.side,
        demo: claim.demo,
        stakeMicroUsdc: claim.stakeMicrousdc,
        status: claim.status,
        deadline: claim.deadline,
        movedPly: claim.movedPly,
      })),
    stakeEntries: database.db
      .select()
      .from(schema.stakeEntries)
      .all()
      .map((entry) => ({
        id: entry.id,
        gameId: entry.gameId,
        claimId: entry.claimId,
        player: entry.player,
        side: entry.side,
        kind: entry.kind,
        amountMicroUsdc: entry.amount,
        ply: entry.ply,
        payoutMicroUsdc: entry.payoutAmount,
      })),
    paymentIntents: database.db
      .select()
      .from(schema.paymentIntents)
      .all()
      .map((intent) => ({
        id: intent.id,
        claimId: intent.claimId,
        status: intent.status,
        amountMicroUsdc: intent.amount,
      })),
    payoutJobs: database.db
      .select()
      .from(schema.payoutJobs)
      .all()
      .map((job) => ({
        gameId: job.gameId,
        recipient: job.recipient,
        amountMicroUsdc: job.amount,
        reason: job.reason,
        status: job.status,
      })),
  };
}

export function ledgerConservation(database: OpenedDatabase): {
  readonly rows: number;
  readonly balanced: boolean;
  readonly totalDelta: number;
  readonly materializedTotal: number;
  readonly differences: Readonly<Record<string, readonly [number, number]>>;
} {
  const totals = new Map<string, number>();
  for (const row of database.db.select().from(schema.ledger).all()) {
    totals.set(
      row.account,
      (totals.get(row.account) ?? 0) + row.deltaMicrousdc,
    );
  }
  const balances = new Map(
    database.db
      .select()
      .from(schema.ledgerBalances)
      .all()
      .map((row) => [row.account, row.balanceMicrousdc]),
  );
  const accounts = new Set([...totals.keys(), ...balances.keys()]);
  const totalDelta = [...totals.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const differences = Object.fromEntries(
    [...accounts]
      .map(
        (account) =>
          [
            account,
            [totals.get(account) ?? 0, balances.get(account) ?? 0] as const,
          ] as const,
      )
      .filter(([, [resummed, materialized]]) => resummed !== materialized),
  );
  const materializedTotal = [...balances.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    rows: database.db.select().from(schema.ledger).all().length,
    balanced:
      totalDelta === materializedTotal && Object.keys(differences).length === 0,
    totalDelta,
    materializedTotal,
    differences,
  };
}
