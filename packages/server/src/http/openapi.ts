import { OpenAPIHono } from "@hono/zod-openapi";
import {
  MOVE_RESOURCE_DESCRIPTION,
  MOVE_RESOURCE_MIME_TYPE,
  moveBazaarExtensions,
  X402_GLOBAL_CHALLENGE_TAG,
} from "@onestepchess/core";
import type { Hono } from "hono";
import { type AppEnv, ERROR_STATUS } from "./app.js";
import { publicApiRoutes } from "./contracts.js";

const EXAMPLE_AT = "2026-07-26T12:00:00.000Z";
const EXAMPLE_FEN =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const EXAMPLE_MOVE = { uci: "e2e4", san: "e4" };

const publishedErrors = [
  ...Object.keys(ERROR_STATUS).filter((code) => code !== "NOT_FOUND"),
  "NO_BOARDS",
  "PAYMENT_PENDING",
].sort();

/** Examples consumed by the repo-side agent-kit schema-drift mirror. They live
 * in the generated document rather than importing the published client into
 * production server code. */
const agentKitExamples = {
  meta: {
    name: "One Step Chess",
    network: {
      caip2: "mock:local",
      usdcAssetId: "31566704",
      treasuryAddress: "MOCK_TREASURY",
      facilitatorUrl: "http://localhost:4402",
      explorerBaseUrl: "https://explorer.perawallet.app",
      algodUrl: "http://localhost:4001",
    },
    economics: {
      humanStakeMicroUsdc: 10_000,
      agentStakeMicroUsdc: 1_000,
      endspielStakeMicroUsdc: 200,
      drawFeeMicroUsdc: 0,
      protocolFeeBps: 0,
      humanTargetMult: 2,
    },
    timing: {
      claimTtlSeconds: { human: 600, agent: 90, endspiel: 30 },
      timerRevealSeconds: 120,
      minPlyIntervalSeconds: 60,
      cooldownPlies: 5,
      nextGameNudgeSeconds: 20,
    },
    quotas: { human: null, agent: 120, demo: 3, windowMinutes: 60 },
    pool: { target: 64, active: 63, endspiel: 1 },
    status: { mode: "running", banner: "mock staging — no real USDC" },
    turnstileSiteKey: "",
    banners: { tower: false, championship: false, custom: "" },
    bonusEnabled: true,
    rules: "One move at a time.",
    docs: {
      llms: "https://osc.example/llms.txt",
      openapi: "https://osc.example/api/v1/openapi.json",
      mcpPackage: "@onestepchess/mcp",
      agentKitPackage: "@onestepchess/agent-kit",
      botRepo: "https://github.com/sergeyshemyakov/onestepchess-bot",
      repo: "https://github.com/sergeyshemyakov/onestepchess",
    },
  },
  profile: {
    address: "AGENT_ADDRESS",
    kind: "agent",
    nickname: "example-agent",
    createdAt: EXAMPLE_AT,
    stats: {
      moves: 1,
      wins: 0,
      draws: 0,
      losses: 0,
      winratePct: null,
    },
    netPnlMicroUsdc: 0,
    quotas: {
      staked: { limit: 120, remaining: 119, resetsAt: EXAMPLE_AT },
      demo: { limit: 3, remaining: 3, resetsAt: null },
    },
    deprioritizedUntil: null,
  },
  claim: {
    claimId: "clm_example",
    yourSide: "white",
    phase: "normal",
    demo: false,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    legalMoves: [EXAMPLE_MOVE],
    stakeMicroUsdc: 1_000,
    deadline: EXAMPLE_AT,
  },
  moveReceipt: {
    status: "moved",
    move: EXAMPLE_MOVE,
    debitMicroUsdc: 1_000,
    txid: "mocktx_000001",
    explorerUrl: null,
    fenAfterYourMove: EXAMPLE_FEN,
  },
  claimStatus: {
    status: "open",
    claim: {
      claimId: "clm_example",
      yourSide: "white",
      phase: "normal",
      demo: false,
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      legalMoves: [EXAMPLE_MOVE],
      stakeMicroUsdc: 1_000,
      deadline: EXAMPLE_AT,
    },
    paymentState: null,
  },
  ongoingGames: {
    items: [
      {
        yourMove: EXAMPLE_MOVE,
        yourSide: "white",
        demo: false,
        stakeMicroUsdc: 1_000,
        claimedAt: EXAMPLE_AT,
        movedAt: EXAMPLE_AT,
        fenBeforeYourMove:
          "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        payTxid: "mocktx_000001",
      },
    ],
    page: 1,
    pageCount: 1,
    total: 1,
  },
  finishedGames: {
    items: [
      {
        yourMoves: [{ ...EXAMPLE_MOVE, ply: 1 }],
        yourSide: "white",
        demo: false,
        stakeMicroUsdc: 1_000,
        thinkingTimeMs: 12_000,
        startedAt: EXAMPLE_AT,
        gameId: "gm_example",
        gameName: "example-game",
        finalFen: EXAMPLE_FEN,
        result: "white",
        termination: "checkmate",
        repetitionAdjudication: null,
        payTxid: "mocktx_000001",
        payoutMicroUsdc: 2_000,
        payoutTxid: "mockpay_000001",
        payoutStatus: "confirmed",
        statsCounted: true,
        finishedAt: EXAMPLE_AT,
      },
    ],
    page: 1,
    pageCount: 1,
    total: 1,
  },
  replay: {
    gameId: "gm_example",
    name: "example-game",
    result: "white",
    termination: "checkmate",
    repetitionAdjudication: null,
    endspielPly: 60,
    createdAt: EXAMPLE_AT,
    finishedAt: EXAMPLE_AT,
    plies: [
      {
        ply: 1,
        side: "white",
        move: EXAMPLE_MOVE,
        fenAfter: EXAMPLE_FEN,
        author: {
          nickname: "example-agent",
          kind: "agent",
          winratePct: 100,
          movesTotal: 1,
        },
        stakeMicroUsdc: 1_000,
        demo: false,
      },
    ],
    pgn: "1. e4# 1-0",
  },
  paymentRequired: {
    x402Version: 2,
    resource: {
      url: "https://osc.example/api/v1/moves",
      description: MOVE_RESOURCE_DESCRIPTION,
      mimeType: MOVE_RESOURCE_MIME_TYPE,
    },
    accepts: [
      {
        scheme: "mock",
        network: "mock:local",
        asset: "31566704",
        amount: "1000",
        payTo: "MOCK_TREASURY",
        maxTimeoutSeconds: 120,
        extra: { tag: X402_GLOBAL_CHALLENGE_TAG },
      },
    ],
    extensions: moveBazaarExtensions(),
  },
  errors: Object.fromEntries(
    publishedErrors.map((error) => [
      error,
      {
        error,
        hint: "example recovery hint",
        docs: `https://osc.example/llms.txt#err-${error.toLowerCase()}`,
      },
    ]),
  ),
} as const;

/** OpenAPI 3.1 generated from the shared Zod route contracts used by the live
 * handlers. Admin routes (§6.5) and admin-token metrics stay private. */
export function buildOpenApiDocument(opts: {
  readonly publicBaseUrl: string;
}): unknown {
  const registry = new OpenAPIHono();
  registry.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  registry.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "osc_session",
  });
  for (const route of publicApiRoutes) {
    registry.openAPIRegistry.registerPath(route);
  }
  const document = registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "One Step Chess API",
      version: "1.0.0",
      description:
        "Public human and agent API. Admin and operational routes are excluded.",
    },
    servers: [{ url: opts.publicBaseUrl }],
  });
  return { ...document, "x-agent-kit-examples": agentKitExamples };
}

export function registerOpenApiRoute(
  app: Hono<AppEnv>,
  opts: { readonly publicBaseUrl: string },
): void {
  const document = buildOpenApiDocument(opts);
  app.get("/api/v1/openapi.json", (c) => c.json(document));
}
