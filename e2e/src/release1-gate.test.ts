import {
  buildPaymentHeader,
  decodePaymentRequired,
} from "@onestepchess/agent-kit";
import {
  checkDomainInvariants,
  createRng,
  type DomainSnapshot,
  gameRulesSchema,
  type PaymentRequired,
} from "@onestepchess/core";
import { createMockRail } from "@onestepchess/rail-mock";
import {
  ChessAdapterRegistry,
  Coordinator,
  CoordinatorViews,
  createApp,
  createLogger,
  type OpenedDatabase,
  openDatabase,
  registerAuthRoutes,
  registerClaimCommands,
  registerClaimRoutes,
  registerLifecycle,
  registerPayoutCommands,
  registerResolution,
  runPayoutExecutor,
  type ServerConfig,
  schema,
  serverConfigSchema,
  TimerService,
} from "@onestepchess/server";
import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";

const BASE_URL = "https://release1-gate.example";
const JWT_SECRET = "release-one-gate-jwt-secret-0123456789";
const INITIAL_TREASURY = 1_000_000;
const SCRIPT = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];

type GateStack = Awaited<ReturnType<typeof createGateStack>>;
type Identity = {
  readonly address: string;
  readonly token: string;
  readonly ip: string;
};

type ClaimView = {
  readonly claimId: string;
  readonly legalMoves: readonly {
    readonly uci: string;
    readonly san: string;
  }[];
  readonly stakeMicroUsdc: number;
};

type Receipt = {
  readonly status: "moved";
  readonly move: { readonly uci: string; readonly san: string };
  readonly debitMicroUsdc: number;
  readonly txid: string;
};

async function createGateStack() {
  const database = openDatabase({ path: ":memory:" });
  const config: ServerConfig = serverConfigSchema.parse({
    GAME_POOL_TARGET: 1,
    MIN_PLY_INTERVAL_SECONDS: 1,
    COOLDOWN_PLIES: 5,
    CLAIM_TTL_HUMAN: 60,
    RATE_LIMIT_AUTH_PER_IP_MIN: 100,
    RATE_LIMIT_CLAIMS_PER_IP_MIN: 100,
  });
  let now = 1_700_000_000_000;
  const logger = createLogger({ level: "silent" });
  const rail = createMockRail({
    initialTreasury: { usdcMicroUsdc: INITIAL_TREASURY },
  });
  database.db
    .insert(schema.systemState)
    .values({
      id: 1,
      railKind: "mock",
      caip2: config.CAIP2,
      usdcAsset: config.USDC_ASA,
      treasuryAddress: rail.treasuryAddress,
      pauseCausesJson: "[]",
      updatedAt: now,
    })
    .run();
  const views = new CoordinatorViews();
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger,
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
    rng: createRng(101),
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
    rng: createRng(202),
    jwtSecret: JWT_SECRET,
    trustProxyHops: 1,
    publicBaseUrl: BASE_URL,
    mode: () => "running" as const,
    turnstile: async () => "pass" as const,
  };
  registerClaimCommands(claimDeps);
  registerResolution({ coordinator, db: database.db, logger });
  const payoutDeps = {
    coordinator,
    db: database.db,
    rail,
    config: () => config,
    now: () => now,
    logger,
  };
  registerPayoutCommands(payoutDeps);

  const app = createApp({
    logger,
    publicBaseUrl: BASE_URL,
    mode: claimDeps.mode,
  });
  registerAuthRoutes(app, {
    db: database.db,
    rail,
    config: () => config,
    publicBaseUrl: BASE_URL,
    jwtSecret: JWT_SECRET,
    trustProxyHops: 1,
    turnstile: async () => "pass",
    now: () => now,
    rng: createRng(303),
  });
  registerClaimRoutes(app, claimDeps);
  await coordinator.dispatch({ type: "PoolTick", payload: {} });

  return {
    app,
    config,
    coordinator,
    database,
    payoutDeps,
    rail,
    timers,
    advancePacing: () => {
      now += config.MIN_PLY_INTERVAL_SECONDS * 1_000;
    },
  };
}

async function postJson(
  stack: GateStack,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  return stack.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function registerIdentity(
  stack: GateStack,
  index: number,
): Promise<Identity> {
  const account = algosdk.generateAccount();
  const address = account.addr.toString();
  const ip = `10.0.0.${index + 1}`;
  const challengeResponse = await postJson(
    stack,
    "/api/v1/auth/challenge",
    { address },
    { "x-forwarded-for": ip },
  );
  expect(challengeResponse.status, `identity ${index + 1} challenge`).toBe(200);
  const challenge = (await challengeResponse.json()) as {
    readonly fallbackTxnB64: string;
  };
  const transaction = algosdk.decodeUnsignedTransaction(
    new Uint8Array(Buffer.from(challenge.fallbackTxnB64, "base64")),
  );
  const signedTxnB64 = Buffer.from(transaction.signTxn(account.sk)).toString(
    "base64",
  );
  const verifyResponse = await postJson(
    stack,
    "/api/v1/auth/verify",
    {
      address,
      method: "txn",
      signedTxnB64,
      kind: "human",
      nickname: `release1-${index + 1}`,
      turnstileToken: `fixture-${index + 1}`,
    },
    { "x-forwarded-for": ip },
  );
  expect(verifyResponse.status, `identity ${index + 1} registration`).toBe(200);
  const verified = (await verifyResponse.json()) as { readonly jwt: string };
  return { address, token: verified.jwt, ip };
}

function synthesizeMockHeader(
  required: PaymentRequired,
  identity: Identity,
  nonce: string,
): string {
  const accepted = required.accepts[0];
  if (accepted === undefined) throw new Error("challenge has no accepted rail");
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: required.resource,
      accepted,
      extensions: required.extensions,
      payload: {
        from: identity.address,
        amountMicroUsdc: Number(accepted.amount),
        asset: accepted.asset,
        payTo: accepted.payTo,
        nonce,
      },
    }),
    "utf8",
  ).toString("base64");
}

async function playPaidMove(
  stack: GateStack,
  identity: Identity,
  move: string,
  ply: number,
): Promise<Receipt> {
  const authHeaders = {
    authorization: `Bearer ${identity.token}`,
    "x-forwarded-for": identity.ip,
  };
  const claimResponse = await postJson(
    stack,
    "/api/v1/claims",
    { demo: false },
    authHeaders,
  );
  expect(claimResponse.status, `ply ${ply} claim`).toBe(201);
  const { claim } = (await claimResponse.json()) as {
    readonly claim: ClaimView;
  };
  expect(
    claim.legalMoves.some((legal) => legal.uci === move),
    `ply ${ply} is present in the public legal-move set`,
  ).toBe(true);

  const challengeResponse = await postJson(
    stack,
    `/api/v1/claims/${claim.claimId}/move`,
    { move },
    authHeaders,
  );
  expect(challengeResponse.status, `ply ${ply} x402 challenge`).toBe(402);
  const requiredHeader = challengeResponse.headers.get("PAYMENT-REQUIRED");
  if (requiredHeader === null)
    throw new Error("missing PAYMENT-REQUIRED header");
  const required = JSON.parse(
    Buffer.from(requiredHeader, "base64").toString("utf8"),
  ) as PaymentRequired;
  const paymentHeader = synthesizeMockHeader(
    required,
    identity,
    `release1-ply-${ply}`,
  );
  const moveResponse = await postJson(
    stack,
    `/api/v1/claims/${claim.claimId}/move`,
    { move },
    { ...authHeaders, "PAYMENT-SIGNATURE": paymentHeader },
  );
  expect(moveResponse.status, `ply ${ply} paid move`).toBe(200);
  const receipt = (await moveResponse.json()) as Receipt;
  expect(receipt.debitMicroUsdc, `ply ${ply} debit`).toBe(claim.stakeMicroUsdc);
  expect(receipt.txid, `ply ${ply} settlement txid`).toMatch(/^mocktx_/);
  return receipt;
}

function domainSnapshot(
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

function assertLedgerConservation(database: OpenedDatabase): void {
  const rows = database.db.select().from(schema.ledger).all();
  const balances = new Map(
    database.db
      .select()
      .from(schema.ledgerBalances)
      .all()
      .map((row) => [row.account, row.balanceMicrousdc]),
  );
  const resummed = new Map<string, number>();
  for (const row of rows) {
    resummed.set(
      row.account,
      (resummed.get(row.account) ?? 0) + row.deltaMicrousdc,
    );
  }
  expect(resummed, "ledger re-sum equals materialized balances").toEqual(
    balances,
  );
  expect(
    [...resummed.values()].reduce((sum, amount) => sum + amount, 0),
    "ledger is globally conserved",
  ).toBe(0);
}

describe("Release 1 gate", () => {
  it("challenge_launch_acceptance_preserves_bazaar_from_authenticated_402_through_receipt", async () => {
    const stack = await createGateStack();
    try {
      const identity = await registerIdentity(stack, 0);
      const authHeaders = {
        authorization: `Bearer ${identity.token}`,
        "x-forwarded-for": identity.ip,
      };
      const claimResponse = await postJson(
        stack,
        "/api/v1/claims",
        { demo: false },
        authHeaders,
      );
      expect(claimResponse.status).toBe(201);
      const { claim } = (await claimResponse.json()) as {
        readonly claim: ClaimView;
      };
      const path = `/api/v1/claims/${claim.claimId}/move`;
      const challengeResponse = await postJson(
        stack,
        path,
        { move: "e2e4" },
        authHeaders,
      );
      expect(challengeResponse.status).toBe(402);
      const initialHeader = challengeResponse.headers.get("PAYMENT-REQUIRED");
      if (initialHeader === null)
        throw new Error("missing PAYMENT-REQUIRED header");
      const required = decodePaymentRequired(initialHeader);
      const requirement = required.accepts[0];
      if (requirement === undefined)
        throw new Error("challenge has no payment requirement");
      expect(required.resource).toMatchObject({
        description:
          "Submit one legal move to an active shared One Step Chess game and receive the committed move and Algorand settlement receipt.",
        mimeType: "application/json",
      });
      expect(requirement.extra.tag).toBe("x402-global-challenge");
      expect(required.extensions).toMatchObject({
        bazaar: {
          info: {
            input: {
              type: "http",
              method: "POST",
              bodyType: "json",
              body: { move: "e2e4" },
            },
            output: { type: "json" },
          },
        },
      });

      const browserHeader = synthesizeMockHeader(
        JSON.parse(
          Buffer.from(initialHeader, "base64").toString("utf8"),
        ) as PaymentRequired,
        identity,
        "challenge-browser",
      );
      const agentHeader = await buildPaymentHeader({
        paymentRequired: required,
        requirement,
        signer: {
          address: identity.address,
          sign: () => {
            throw new Error("mock payments never sign");
          },
        },
        nonce: () => "challenge-agent",
      });
      for (const header of [browserHeader, agentHeader]) {
        const payload = JSON.parse(
          Buffer.from(header, "base64").toString("utf8"),
        );
        expect(payload.accepted.extra.tag).toBe("x402-global-challenge");
        expect(payload.extensions).toEqual(required.extensions);
      }

      const verify = vi.spyOn(stack.rail, "verify");
      const settle = vi.spyOn(stack.rail, "settle");
      const moved = await postJson(
        stack,
        path,
        { move: "e2e4" },
        {
          ...authHeaders,
          "PAYMENT-SIGNATURE": browserHeader,
        },
      );
      expect(moved.status).toBe(200);
      expect(await moved.json()).toMatchObject({
        status: "moved",
        move: { uci: "e2e4" },
        debitMicroUsdc: claim.stakeMicroUsdc,
        txid: expect.stringMatching(/^mocktx_/),
      });
      expect(moved.headers.get("PAYMENT-RESPONSE")).not.toBeNull();
      expect(verify).toHaveBeenCalledWith(
        browserHeader,
        expect.objectContaining({ extensions: required.extensions }),
      );
      expect(settle).toHaveBeenCalledWith(
        browserHeader,
        expect.objectContaining({ extensions: required.extensions }),
      );
    } finally {
      stack.timers.disarmAll();
      stack.database.sqlite.close();
    }
  });

  it("release1-gate: seven-ply checkmate settles and resolves once", async () => {
    const stack = await createGateStack();
    try {
      const identities: Identity[] = [];
      for (let index = 0; index < 6; index += 1) {
        identities.push(await registerIdentity(stack, index));
      }
      const playerOrder = [0, 1, 2, 3, 4, 5, 0] as const;
      const receipts: Receipt[] = [];
      for (const [index, move] of SCRIPT.entries()) {
        const identity = identities[playerOrder[index] ?? -1];
        if (identity === undefined)
          throw new Error(`missing identity for ply ${index + 1}`);
        receipts.push(await playPaidMove(stack, identity, move, index + 1));
        stack.advancePacing();
      }

      await stack.coordinator.onIdle();
      await runPayoutExecutor(stack.payoutDeps);
      await stack.coordinator.onIdle();

      const games = stack.database.db.select().from(schema.games).all();
      const finished = games.find((game) => game.status === "finished");
      expect(
        finished,
        "the scripted game reaches a terminal row",
      ).toBeDefined();
      expect(
        finished === undefined ? [] : JSON.parse(finished.historyJson),
        "all seven public-API moves were legal and persisted",
      ).toEqual(SCRIPT);
      expect(
        receipts.map((receipt) => receipt.move.uci),
        "all move receipts match the script",
      ).toEqual(SCRIPT);

      const intents = stack.database.db
        .select()
        .from(schema.paymentIntents)
        .all();
      const stakeLedger = stack.database.db
        .select()
        .from(schema.ledger)
        .all()
        .filter((row) => row.refType === "stake");
      expect(intents, "each paid move settles exactly once").toHaveLength(7);
      expect(new Set(intents.map((intent) => intent.clientTxid)).size).toBe(7);
      expect(intents.every((intent) => intent.status === "settled")).toBe(true);
      expect(
        stakeLedger,
        "each settlement has one stake ledger row",
      ).toHaveLength(7);

      const resolvedEvents = stack.database.db
        .select()
        .from(schema.events)
        .all()
        .filter((event) => event.type === "game_resolved");
      const jobs = stack.database.db.select().from(schema.payoutJobs).all();
      expect(
        finished?.resolvedAt,
        "the game resolves exactly once",
      ).not.toBeNull();
      expect(
        resolvedEvents,
        "one resolution event per distinct participant",
      ).toHaveLength(6);
      expect(new Set(jobs.map((job) => job.recipient)).size).toBe(jobs.length);

      expect(
        checkDomainInvariants(domainSnapshot(stack.database, stack.config), {
          verifyFens: true,
        }),
        "the DB maps to an invariant-clean core DomainSnapshot",
      ).toEqual([]);
      assertLedgerConservation(stack.database);

      const payoutLedger = stack.database.db
        .select()
        .from(schema.ledger)
        .all()
        .filter((row) => row.refType === "payout");
      expect(jobs.length, "resolution creates payout jobs").toBeGreaterThan(0);
      expect(jobs.every((job) => job.status === "confirmed")).toBe(true);
      expect(
        payoutLedger,
        "every payout job is applied exactly once",
      ).toHaveLength(jobs.length);
      expect(new Set(payoutLedger.map((row) => row.refId)).size).toBe(
        jobs.length,
      );
      expect(
        (await stack.rail.getBalances(stack.rail.treasuryAddress))
          .usdcMicroUsdc,
        "mock treasury echo equals initial plus settles minus payouts",
      ).toBe(INITIAL_TREASURY);
    } finally {
      stack.timers.disarmAll();
      stack.database.sqlite.close();
    }
  });
});
