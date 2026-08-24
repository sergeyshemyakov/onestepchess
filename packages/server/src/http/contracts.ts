import { createRoute, z } from "@hono/zod-openapi";

const isoTimestamp = z.iso.datetime({ offset: true });
const side = z.enum(["white", "black"]);
const gameResult = z.enum(["white", "black", "draw", "aborted"]);
const termination = z.enum([
  "checkmate",
  "stalemate",
  "insufficient",
  "threefold",
  "fifty_move",
  "max_plies",
  "aborted",
]);
const repetitionAdjudication = z
  .object({
    whiteMaterialPoints: z.number().int().nonnegative(),
    blackMaterialPoints: z.number().int().nonnegative(),
    winMargin: z.number().int().positive(),
  })
  .nullable();

export const challengeBodySchema = z.object({ address: z.string().min(1) });

export const verifyBodySchema = z.intersection(
  z.object({
    address: z.string().min(1),
    nickname: z.string().optional(),
    kind: z.enum(["human", "agent"]).optional(),
    turnstileToken: z.string().optional(),
    ref: z.string().optional(),
  }),
  z.discriminatedUnion("method", [
    z.object({
      method: z.literal("arc60"),
      proof: z.object({
        signatureB64: z.string().min(1),
        authenticatorDataB64: z.string().min(1),
      }),
    }),
    z.object({ method: z.literal("txn"), signedTxnB64: z.string().min(1) }),
  ]),
);

export const claimBodySchema = z
  .object({
    demo: z.boolean().optional().default(false),
    turnstileToken: z.string().min(1).optional(),
    ref: z.string().optional(),
  })
  .strict();

export const moveBodySchema = z
  .object({ claimId: z.string().min(1), move: z.string().min(1).max(32) })
  .strict();

export const renameBodySchema = z.object({ nickname: z.string() }).strict();

export const bonusOptInBodySchema = z
  .object({ signedTxnB64: z.string().min(1) })
  .strict();

export const bonusSweepBodySchema = z
  .object({ signedTxnsB64: z.array(z.string().min(1)).min(1).max(2) })
  .strict();

export const gamesQuerySchema = z
  .object({
    status: z.enum(["ongoing", "finished"]),
    page: z.coerce.number().int().positive().default(1),
  })
  .strict();

export const cardQuerySchema = z
  .object({
    ply: z.coerce.number().int().positive().optional(),
  })
  .strict();

const errorEnvelope = z
  .object({
    error: z.string(),
    hint: z.string(),
    docs: z.url(),
    suggestion: z.string().optional(),
    legalMoves: z
      .array(z.object({ uci: z.string(), san: z.string() }))
      .optional(),
    requestId: z.string().optional(),
  })
  .meta({ id: "ErrorEnvelope" });

const playerView = z
  .object({
    address: z.string(),
    kind: z.enum(["human", "agent"]),
    nickname: z.string().nullable(),
    createdAt: isoTimestamp,
  })
  .meta({ id: "PlayerView" });

const legalMove = z.object({ uci: z.string(), san: z.string() });

const claimView = z
  .object({
    claimId: z.string(),
    yourSide: side,
    phase: z.enum(["normal", "endspiel"]),
    demo: z.boolean(),
    fen: z.string(),
    legalMoves: z.array(legalMove),
    stakeMicroUsdc: z.number().int().nonnegative(),
    deadline: isoTimestamp,
    board: z.string().optional(),
  })
  .meta({ id: "ClaimView" });

const claimResponse = z.object({ claim: claimView });

const moveReceipt = z
  .object({
    status: z.literal("moved"),
    move: legalMove,
    debitMicroUsdc: z.number().int().nonnegative(),
    txid: z.string().nullable(),
    explorerUrl: z.string().nullable(),
    fenAfterYourMove: z.string(),
  })
  .meta({ id: "MoveReceipt" });

const paymentPending = z.object({
  status: z.literal("payment_pending"),
  claimId: z.string(),
  retryAfterSeconds: z.number().int().positive(),
});

const challengeResponse = z.object({
  nonce: z.string(),
  expiresAt: isoTimestamp,
  arc60Payload: z.object({
    data: z.string(),
    metadata: z.object({
      scope: z.literal(1),
      encoding: z.literal("base64"),
    }),
  }),
  fallbackTxnB64: z.string(),
});

const verifyResponse = z.object({
  player: playerView,
  jwt: z.string(),
  linkedGuestClaims: z.number().int().nonnegative().optional(),
});

// A null limit/remaining means the window is uncapped (staked human claims).
const quota = z.object({
  limit: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
  resetsAt: isoTimestamp.nullable(),
});

const profile = playerView.extend({
  stats: z.object({
    moves: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    draws: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    winratePct: z.number().min(0).max(100).nullable(),
  }),
  netPnlMicroUsdc: z.number().int(),
  balances: z
    .object({
      usdcMicroUsdc: z.number().int().nonnegative(),
      algoMicroAlgo: z.number().int().nonnegative(),
    })
    .optional(),
  quotas: z.object({ staked: quota, demo: quota }),
  deprioritizedUntil: isoTimestamp.nullable(),
  // Humans-only incentive fields (F15) — absent for agents.
  points: z.number().int().nonnegative().optional(),
  refCode: z.string().nullable().optional(),
  referrals: z
    .object({
      joined: z.number().int().nonnegative(),
      qualified: z.number().int().nonnegative(),
    })
    .optional(),
  bonus: z
    .object({
      status: z.enum(["available", "claimed", "opted_in", "funded"]),
      algoTxid: z.string().optional(),
      algoReady: z.boolean().optional(),
    })
    .optional(),
});

const bonusClaimResponse = z.object({
  bonus: z.object({
    status: z.literal("claimed"),
    claimedAt: isoTimestamp,
  }),
});

const bonusOptInTxnResponse = z.object({ unsignedTxnB64: z.string().min(1) });
const bonusOptInResponse = z.object({ status: z.literal("watching") });

const sweepLeg = z.enum(["usdc", "algo"]);
const bonusSweepTxnsResponse = z.object({
  receiver: z.string().min(1),
  txns: z
    .array(
      z.object({
        leg: sweepLeg,
        unsignedTxnB64: z.string().min(1),
        amount: z.number().int().positive(),
      }),
    )
    .max(2),
});
const bonusSweepResponse = z.object({
  status: z.literal("submitted"),
  txids: z.array(z.object({ leg: sweepLeg, txid: z.string().min(1) })).max(2),
});

const ongoingGameCard = z.object({
  yourMove: legalMove,
  yourSide: side,
  demo: z.boolean(),
  stakeMicroUsdc: z.number().int().nonnegative(),
  claimedAt: isoTimestamp,
  movedAt: isoTimestamp,
  fenBeforeYourMove: z.string(),
  payTxid: z.string().nullable(),
});

const finishedGameCardCommon = z.object({
  yourSide: side,
  stakeMicroUsdc: z.number().int().nonnegative(),
  thinkingTimeMs: z.number().int().nonnegative(),
  startedAt: isoTimestamp,
  result: gameResult,
  termination,
  repetitionAdjudication,
  finishedAt: isoTimestamp,
});

const demoFinishedGameCard = finishedGameCardCommon.extend({
  demo: z.literal(true),
  yourMoves: z.array(legalMove).min(1),
  payoutMicroUsdc: z.literal(0),
  payoutStatus: z.null(),
  statsCounted: z.literal(false),
});

const stakedFinishedGameCard = finishedGameCardCommon.extend({
  demo: z.literal(false),
  gameId: z.string(),
  gameName: z.string(),
  finalFen: z.string(),
  yourMoves: z
    .array(legalMove.extend({ ply: z.number().int().positive() }))
    .min(1),
  payTxid: z.string().nullable(),
  payoutMicroUsdc: z.number().int().nonnegative(),
  payoutTxid: z.string().nullable(),
  payoutStatus: z.enum(["none", "queued", "confirmed", "failed"]),
  statsCounted: z.literal(true),
});

const gamesPage = z.object({
  items: z.array(
    z.union([ongoingGameCard, demoFinishedGameCard, stakedFinishedGameCard]),
  ),
  page: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const replay = z.object({
  gameId: z.string(),
  name: z.string(),
  result: gameResult,
  termination,
  repetitionAdjudication,
  endspielPly: z.number().int().positive().nullable(),
  createdAt: isoTimestamp,
  finishedAt: isoTimestamp,
  plies: z.array(
    z.object({
      ply: z.number().int().positive(),
      side,
      move: legalMove,
      fenAfter: z.string(),
      author: z.object({
        nickname: z.string().nullable(),
        kind: z.enum(["human", "agent", "guest"]),
        winratePct: z.number().min(0).max(100).nullable(),
        movesTotal: z.number().int().nonnegative(),
      }),
      stakeMicroUsdc: z.number().int().nonnegative(),
      demo: z.boolean(),
    }),
  ),
  pgn: z.string(),
});

const claimStatus = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("open"),
    claim: claimView,
    paymentState: z.enum(["verifying", "settling"]).nullable(),
  }),
  z.object({ status: z.literal("moved"), receipt: moveReceipt }),
  z.object({ status: z.literal("expired") }),
]);

const metaResponse = z.object({
  name: z.string(),
  network: z.object({
    caip2: z.string(),
    usdcAssetId: z.string(),
    treasuryAddress: z.string(),
    facilitatorUrl: z.url(),
    explorerBaseUrl: z.url(),
    algodUrl: z.url(),
  }),
  economics: z.object({
    humanStakeMicroUsdc: z.number().int().nonnegative(),
    agentStakeMicroUsdc: z.number().int().nonnegative(),
    endspielStakeMicroUsdc: z.number().int().nonnegative(),
    drawFeeMicroUsdc: z.number().int().nonnegative(),
    protocolFeeBps: z.number().int().nonnegative(),
    humanTargetMult: z.number().positive(),
  }),
  timing: z.object({
    claimTtlSeconds: z.object({
      human: z.number().int().positive(),
      agent: z.number().int().positive(),
      endspiel: z.number().int().positive(),
    }),
    timerRevealSeconds: z.number().int().positive(),
    minPlyIntervalSeconds: z.number().int().nonnegative(),
    cooldownPlies: z.number().int().nonnegative(),
    nextGameNudgeSeconds: z.number().int().positive(),
  }),
  quotas: z.object({
    human: z.number().int().nonnegative().nullable(),
    agent: z.number().int().nonnegative(),
    demo: z.number().int().nonnegative(),
    windowMinutes: z.number().int().positive(),
  }),
  pool: z.object({
    target: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    endspiel: z.number().int().nonnegative(),
  }),
  status: z.object({
    mode: z.enum(["running", "paused"]),
    banner: z.string().nullable(),
  }),
  turnstileSiteKey: z.string(),
  banners: z.object({
    tower: z.boolean(),
    championship: z.boolean(),
    custom: z.string(),
  }),
  bonusEnabled: z.boolean(),
  // Present only when PUBLIC_STATS_ENABLED (F16 step 4).
  stats: z
    .object({
      humanMoves: z.number().int().nonnegative(),
      playersRegistered: z.number().int().nonnegative(),
      gamesFinished: z.number().int().nonnegative(),
      movesSettled: z.number().int().nonnegative(),
    })
    .optional(),
  rules: z.string(),
  docs: z.object({
    llms: z.url(),
    openapi: z.url(),
    mcpPackage: z.literal("@onestepchess/mcp"),
    agentKitPackage: z.literal("@onestepchess/agent-kit"),
    botRepo: z.url(),
    repo: z.url(),
  }),
});

const idParam = z.object({
  id: z.string().meta({ param: { name: "id", in: "path" } }),
});

const claimIncludeQuery = z.object({
  include: z.enum(["ascii"]).optional(),
});

const profileIncludeQuery = z.object({
  include: z.enum(["balances"]).optional(),
});

const eventsQuery = z.object({
  lastEventId: z.coerce.number().int().nonnegative().optional(),
});

function json<T extends z.ZodType>(description: string, schema: T) {
  return { description, content: { "application/json": { schema } } };
}

const bearerOrCookie: Record<string, string[]>[] = [
  { bearerAuth: [] },
  { cookieAuth: [] },
];

export const publicApiRoutes = [
  createRoute({
    method: "post",
    path: "/api/v1/auth/challenge",
    tags: ["auth"],
    summary: "Request a wallet-signature challenge",
    request: {
      body: {
        content: { "application/json": { schema: challengeBodySchema } },
      },
    },
    responses: {
      200: json(
        "Canonical ARC-60 and fallback-transaction challenge",
        challengeResponse,
      ),
      400: json("Invalid request or address", errorEnvelope),
    },
  }),
  createRoute({
    method: "post",
    path: "/api/v1/auth/verify",
    tags: ["auth"],
    summary: "Verify an ARC-60 or fallback-transaction proof",
    request: {
      body: { content: { "application/json": { schema: verifyBodySchema } } },
    },
    responses: {
      200: json("Authenticated player and bearer token", verifyResponse),
      400: json("Invalid proof or registration fields", errorEnvelope),
      401: json("Signature did not verify", errorEnvelope),
    },
  }),
  createRoute({
    method: "post",
    path: "/api/v1/auth/logout",
    tags: ["auth"],
    summary: "Revoke the current session",
    security: bearerOrCookie,
    responses: {
      204: { description: "Logged out" },
      401: json("Not authenticated", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/auth/suggest-nickname",
    tags: ["auth"],
    summary: "Suggest an available nickname",
    responses: {
      200: json("A free nickname", z.object({ nickname: z.string() })),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/meta",
    tags: ["discovery"],
    summary: "Network, economics, timing, quotas, status, and documentation",
    responses: { 200: json("Server metadata", metaResponse) },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/my/profile",
    tags: ["human"],
    summary: "The authenticated player's profile",
    security: bearerOrCookie,
    request: { query: profileIncludeQuery },
    responses: {
      200: json("Profile", profile),
      401: json("Not authenticated", errorEnvelope),
    },
  }),
  createRoute({
    method: "patch",
    path: "/api/v1/my/profile",
    tags: ["human"],
    summary: "Rename the authenticated player",
    security: bearerOrCookie,
    request: {
      body: { content: { "application/json": { schema: renameBodySchema } } },
    },
    responses: {
      200: json("Updated profile identity", z.object({ player: playerView })),
      400: json("Invalid nickname", errorEnvelope),
      409: json("Nickname taken", errorEnvelope),
      429: json("Rename limit reached", errorEnvelope),
    },
  }),
  createRoute({
    method: "post",
    path: "/api/v1/my/bonus/claim",
    tags: ["human"],
    summary: "Claim an eligible one-time starter stake",
    security: bearerOrCookie,
    responses: {
      200: json("Durable starter-stake claim", bonusClaimResponse),
      403: json("Player is not eligible", errorEnvelope),
      429: json("Program disabled or UTC cap reached", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/my/bonus/optin-txn",
    tags: ["human"],
    summary: "Build the exact USDC opt-in transaction",
    security: bearerOrCookie,
    responses: {
      200: json("Unsigned USDC self-transfer", bonusOptInTxnResponse),
      403: json("No claimed starter stake", errorEnvelope),
      503: json("Algod unavailable", errorEnvelope),
    },
  }),
  createRoute({
    method: "post",
    path: "/api/v1/my/bonus/optin",
    tags: ["human"],
    summary: "Validate and relay the signed USDC opt-in",
    security: bearerOrCookie,
    request: {
      body: {
        content: { "application/json": { schema: bonusOptInBodySchema } },
      },
    },
    responses: {
      202: json("Opt-in accepted or ambiguously submitted", bonusOptInResponse),
      400: json("Malformed, unsafe, or rejected opt-in", errorEnvelope),
      403: json("No claimed starter stake", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/my/bonus/sweep-txns",
    tags: ["human"],
    summary: "Build the exact welcome-bonus return transactions",
    security: bearerOrCookie,
    responses: {
      200: json("Unsigned bonus-return transactions", bonusSweepTxnsResponse),
      403: json("No starter stake on record", errorEnvelope),
      503: json("Algod unavailable", errorEnvelope),
    },
  }),
  createRoute({
    method: "post",
    path: "/api/v1/my/bonus/sweep",
    tags: ["human"],
    summary: "Validate and relay the signed welcome-bonus return",
    security: bearerOrCookie,
    request: {
      body: {
        content: { "application/json": { schema: bonusSweepBodySchema } },
      },
    },
    responses: {
      200: json("Bonus return submitted", bonusSweepResponse),
      400: json("Malformed, unsafe, or rejected return", errorEnvelope),
      403: json("No starter stake on record", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/my/games",
    tags: ["human"],
    summary: "The player's ongoing or finished game cards",
    security: bearerOrCookie,
    request: { query: gamesQuerySchema },
    responses: {
      200: json("Paginated game cards", gamesPage),
      400: json("Invalid status or page", errorEnvelope),
      401: json("Not authenticated", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/games/{id}/replay",
    tags: ["human"],
    summary: "Full replay of a terminal game",
    request: { params: idParam },
    responses: {
      200: json("Replay document", replay),
      404: json("Game not found or not terminal", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/games/{id}/card.png",
    tags: ["human"],
    summary: "Share-card image for a terminal game",
    request: { params: idParam, query: cardQuerySchema },
    responses: {
      200: {
        description: "1200 by 630 PNG share card",
        content: {
          "image/png": { schema: z.string().meta({ format: "binary" }) },
        },
      },
      400: json("Invalid or out-of-range ply", errorEnvelope),
      404: json("Game not found or not terminal", errorEnvelope),
    },
  }),
  createRoute({
    method: "post",
    path: "/api/v1/claims",
    tags: ["claims"],
    summary: "Get or create a position claim",
    security: bearerOrCookie,
    request: {
      query: claimIncludeQuery,
      body: { content: { "application/json": { schema: claimBodySchema } } },
    },
    responses: {
      200: json("Existing open claim", claimResponse),
      201: json("New claim", claimResponse),
      204: { description: "Nothing eligible; honor Retry-After" },
      400: json("Invalid request", errorEnvelope),
      401: json("Not authenticated", errorEnvelope),
      429: json("Quota or rate limit", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/claims/current",
    tags: ["claims"],
    summary: "The player's current open claim",
    security: bearerOrCookie,
    request: { query: claimIncludeQuery },
    responses: {
      200: json("Open claim", claimResponse),
      404: json("No open claim", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/claims/{id}/status",
    tags: ["claims"],
    summary: "Durable claim and payment status",
    security: bearerOrCookie,
    request: { params: idParam },
    responses: {
      200: json("Claim status", claimStatus),
      403: json("Not the claim owner", errorEnvelope),
      404: json("Claim not found", errorEnvelope),
    },
  }),
  createRoute({
    method: "post",
    path: "/api/v1/moves",
    tags: ["claims"],
    summary: "Submit the one move for a claim",
    security: bearerOrCookie,
    request: {
      body: { content: { "application/json": { schema: moveBodySchema } } },
    },
    responses: {
      200: json("Move receipt", moveReceipt),
      202: json("Payment outcome is pending", paymentPending),
      400: json("Illegal, ambiguous, or invalid move", errorEnvelope),
      402: json("x402 payment required or rejected", errorEnvelope),
      404: json("Claim not found", errorEnvelope),
      409: json("Payment already in flight", errorEnvelope),
      410: json("Claim expired", errorEnvelope),
      503: json("Payment or service unavailable", errorEnvelope),
    },
  }),
  createRoute({
    method: "get",
    path: "/api/v1/events",
    tags: ["events"],
    summary: "Resumable server-sent events stream",
    security: bearerOrCookie,
    request: { query: eventsQuery },
    responses: {
      200: {
        description:
          "text/event-stream; resume with Last-Event-ID or lastEventId",
        content: { "text/event-stream": { schema: z.string() } },
      },
      401: json("Not authenticated", errorEnvelope),
    },
  }),
] as const;

export const publicApiSchemas = {
  challengeBody: challengeBodySchema,
  verifyBody: verifyBodySchema,
  claimBody: claimBodySchema,
  moveBody: moveBodySchema,
  renameBody: renameBodySchema,
  bonusOptInBody: bonusOptInBodySchema,
  bonusSweepBody: bonusSweepBodySchema,
  gamesQuery: gamesQuerySchema,
  cardQuery: cardQuerySchema,
  challengeResponse,
  metaResponse,
  verifyResponse,
  claimResponse,
  moveReceipt,
} as const;
