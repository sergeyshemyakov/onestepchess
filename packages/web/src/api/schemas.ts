import { z } from "zod";

const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();
export const sideSchema = z.enum(["white", "black"]);

// Wire schemas mirroring server spec §6.3 (Release-1 subset). Zod decodes
// every payload so wire drift becomes a controlled error, not silent
// undefined reads (§5.1).

export const moveSchema = z.object({ uci: z.string(), san: z.string() });
export type Move = z.infer<typeof moveSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.string(),
  hint: z.string(),
  docs: z.string(),
  suggestion: z.string().optional(),
  legalMoves: z.array(moveSchema).optional(),
  requestId: z.string().optional(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const metaSchema = z.object({
  name: z.string(),
  network: z.object({
    caip2: z.string(),
    usdcAssetId: z.string(),
    treasuryAddress: z.string(),
    facilitatorUrl: z.string(),
    explorerBaseUrl: z.string(),
    algodUrl: z.string(),
  }),
  economics: z.object({
    humanStakeMicroUsdc: z.number(),
    agentStakeMicroUsdc: z.number(),
    endspielStakeMicroUsdc: z.number(),
    drawFeeMicroUsdc: z.number(),
    protocolFeeBps: z.number(),
    humanTargetMult: z.number(),
  }),
  timing: z.object({
    claimTtlSeconds: z.object({
      human: z.number(),
      agent: z.number(),
      endspiel: z.number(),
    }),
    timerRevealSeconds: z.number(),
    minPlyIntervalSeconds: z.number(),
    cooldownPlies: z.number(),
    nextGameNudgeSeconds: z.number(),
  }),
  quotas: z.object({
    human: z.number().nullable(),
    agent: z.number(),
    demo: z.number(),
    windowMinutes: z.number(),
  }),
  status: z.object({
    mode: z.enum(["running", "paused"]),
    banner: z.string().nullable(),
  }),
  turnstileSiteKey: z.string(),
  banners: z.object({
    tower: z.boolean(),
    championship: z.boolean(),
  }),
  // Present only when the server enables public stats (F-W13 strip gating).
  stats: z
    .object({
      humanMoves: nonNegativeIntegerSchema,
      playersRegistered: nonNegativeIntegerSchema,
      gamesFinished: nonNegativeIntegerSchema,
      movesSettled: nonNegativeIntegerSchema,
    })
    .optional(),
  rules: z.string(),
  docs: z.object({
    llms: z.string(),
    openapi: z.string(),
    mcpPackage: z.string(),
    agentKitPackage: z.string(),
    repo: z.string(),
  }),
});
export type Meta = z.infer<typeof metaSchema>;

export const playerSchema = z.object({
  address: z.string(),
  kind: z.enum(["human", "agent"]),
  nickname: z.string().nullable(),
  createdAt: isoTimestampSchema,
});
export type PlayerView = z.infer<typeof playerSchema>;

export const bonusStatusSchema = z.enum([
  "available",
  "claimed",
  "opted_in",
  "funded",
]);
export type BonusStatus = z.infer<typeof bonusStatusSchema>;

/** A null limit/remaining means the window is uncapped (staked human claims). */
const quotaWindowSchema = z.object({
  limit: nonNegativeIntegerSchema.nullable(),
  remaining: nonNegativeIntegerSchema.nullable(),
  resetsAt: isoTimestampSchema.nullable(),
});

/** Full `/my/profile` payload (server §6.3). `balances` appears only when
 * requested with `?include=balances` (F-W9 — popover-only). Points and
 * referral fields are humans-only. `netPnlMicroUsdc` is decoded but never
 * rendered (non-goal: no net-PnL display). */
export const profileSchema = playerSchema.extend({
  stats: z.object({
    moves: nonNegativeIntegerSchema,
    wins: nonNegativeIntegerSchema,
    draws: nonNegativeIntegerSchema,
    losses: nonNegativeIntegerSchema,
    winratePct: z.number().min(0).max(100).nullable(),
  }),
  netPnlMicroUsdc: z.number().int(),
  balances: z
    .object({
      usdcMicroUsdc: nonNegativeIntegerSchema,
      algoMicroAlgo: nonNegativeIntegerSchema,
    })
    .optional(),
  quotas: z.object({
    staked: quotaWindowSchema,
    demo: quotaWindowSchema,
  }),
  deprioritizedUntil: isoTimestampSchema.nullable(),
  points: nonNegativeIntegerSchema.optional(),
  refCode: z.string().nullable().optional(),
  referrals: z
    .object({
      joined: nonNegativeIntegerSchema,
      qualified: nonNegativeIntegerSchema,
    })
    .optional(),
  bonus: z
    .object({
      status: bonusStatusSchema,
      algoTxid: z.string().optional(),
      algoReady: z.boolean().optional(),
    })
    .optional(),
});
export type ProfileView = z.infer<typeof profileSchema>;

export const bonusClaimResponseSchema = z.object({
  bonus: z.object({
    status: z.literal("claimed"),
    claimedAt: isoTimestampSchema,
  }),
});
export type BonusClaimResponse = z.infer<typeof bonusClaimResponseSchema>;

export const bonusOptInTxnResponseSchema = z.object({
  unsignedTxnB64: z.string().min(1),
});

export const bonusOptInResponseSchema = z.object({
  status: z.literal("watching"),
});

const sweepLegSchema = z.enum(["usdc", "algo"]);
export const bonusSweepQuoteSchema = z.object({
  receiver: z.string().min(1),
  txns: z.array(
    z.object({
      leg: sweepLegSchema,
      unsignedTxnB64: z.string().min(1),
      amount: z.number().int().positive(),
    }),
  ),
});
export type BonusSweepQuote = z.infer<typeof bonusSweepQuoteSchema>;

export const bonusSweepResponseSchema = z.object({
  status: z.literal("submitted"),
  txids: z.array(z.object({ leg: sweepLegSchema, txid: z.string().min(1) })),
});
export type BonusSweepReceipt = z.infer<typeof bonusSweepResponseSchema>;

export const gameResultSchema = z.enum(["white", "black", "draw", "aborted"]);
export type GameResult = z.infer<typeof gameResultSchema>;
export const terminationSchema = z.enum([
  "checkmate",
  "stalemate",
  "insufficient",
  "threefold",
  "fifty_move",
  "max_plies",
  "aborted",
]);
export const repetitionAdjudicationSchema = z
  .object({
    whiteMaterialPoints: nonNegativeIntegerSchema,
    blackMaterialPoints: nonNegativeIntegerSchema,
    winMargin: z.number().int().positive(),
  })
  .nullable();
export type RepetitionAdjudication = z.infer<
  typeof repetitionAdjudicationSchema
>;

/** Ongoing entries never carry game identity (I7 — CA-W2). */
export const ongoingGameItemSchema = z.object({
  yourMove: moveSchema,
  yourSide: sideSchema,
  demo: z.boolean(),
  stakeMicroUsdc: nonNegativeIntegerSchema,
  claimedAt: isoTimestampSchema,
  movedAt: isoTimestampSchema,
  fenBeforeYourMove: z.string(),
  payTxid: z.string().nullable(),
});
export type OngoingGameItem = z.infer<typeof ongoingGameItemSchema>;

const finishedGameItemCommonSchema = z.object({
  yourSide: sideSchema,
  stakeMicroUsdc: nonNegativeIntegerSchema,
  thinkingTimeMs: nonNegativeIntegerSchema,
  startedAt: isoTimestampSchema,
  result: gameResultSchema,
  termination: terminationSchema,
  repetitionAdjudication: repetitionAdjudicationSchema,
  finishedAt: isoTimestampSchema,
});

export const finishedDemoItemSchema = finishedGameItemCommonSchema.extend({
  demo: z.literal(true),
  yourMoves: z.array(moveSchema).min(1),
  payoutMicroUsdc: z.literal(0),
  payoutStatus: z.null(),
  statsCounted: z.literal(false),
});
export type FinishedDemoItem = z.infer<typeof finishedDemoItemSchema>;

export const finishedStakedItemSchema = finishedGameItemCommonSchema.extend({
  demo: z.literal(false),
  gameId: z.string(),
  gameName: z.string(),
  finalFen: z.string(),
  yourMoves: z
    .array(moveSchema.extend({ ply: z.number().int().positive() }))
    .min(1),
  payTxid: z.string().nullable(),
  payoutMicroUsdc: nonNegativeIntegerSchema,
  payoutTxid: z.string().nullable(),
  payoutStatus: z.enum(["none", "queued", "confirmed", "failed"]),
  statsCounted: z.literal(true),
});
export type FinishedStakedItem = z.infer<typeof finishedStakedItemSchema>;

export const finishedGameItemSchema = z.union([
  finishedStakedItemSchema,
  finishedDemoItemSchema,
]);
export type FinishedGameItem = z.infer<typeof finishedGameItemSchema>;

export function gamesPageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().positive(),
    pageCount: nonNegativeIntegerSchema,
    total: nonNegativeIntegerSchema,
  });
}
export type GamesPage<T> = {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
};

export const replayPlySchema = z.object({
  ply: z.number().int().positive(),
  side: sideSchema,
  move: moveSchema,
  fenAfter: z.string(),
  stakeMicroUsdc: nonNegativeIntegerSchema,
  demo: z.boolean(),
  author: z.object({
    nickname: z.string().nullable(),
    kind: z.enum(["human", "agent", "guest"]),
    winratePct: z.number().min(0).max(100).nullable(),
    movesTotal: nonNegativeIntegerSchema,
  }),
});
export type ReplayPly = z.infer<typeof replayPlySchema>;

export const replayViewSchema = z.object({
  gameId: z.string(),
  name: z.string(),
  result: gameResultSchema,
  termination: terminationSchema,
  repetitionAdjudication: repetitionAdjudicationSchema,
  endspielPly: z.number().int().positive().nullable(),
  createdAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  plies: z.array(replayPlySchema),
  pgn: z.string(),
});
export type ReplayView = z.infer<typeof replayViewSchema>;

export const challengeResponseSchema = z.object({
  nonce: z.string(),
  expiresAt: z.string(),
  arc60Payload: z.object({
    data: z.string(),
    metadata: z.object({ scope: z.number(), encoding: z.string() }),
  }),
  fallbackTxnB64: z.string(),
});
export type ChallengeResponse = z.infer<typeof challengeResponseSchema>;

export const verifyResponseSchema = z.object({
  player: playerSchema,
  jwt: z.string(),
  linkedGuestClaims: z.number().optional(),
});
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;

export const claimViewSchema = z.object({
  claimId: z.string(),
  yourSide: sideSchema,
  phase: z.enum(["normal", "endspiel"]),
  demo: z.boolean(),
  fen: z.string(),
  legalMoves: z.array(moveSchema),
  stakeMicroUsdc: z.number(),
  deadline: z.string(),
  board: z.string().optional(),
});
export type ClaimView = z.infer<typeof claimViewSchema>;

export const moveReceiptSchema = z.object({
  status: z.literal("moved"),
  move: moveSchema,
  debitMicroUsdc: z.number(),
  txid: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  fenAfterYourMove: z.string(),
});
export type MoveReceipt = z.infer<typeof moveReceiptSchema>;

export const claimStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("open"),
    claim: claimViewSchema,
    paymentState: z.enum(["verifying", "settling"]).nullable(),
  }),
  z.object({ status: z.literal("moved"), receipt: moveReceiptSchema }),
  z.object({ status: z.literal("expired") }),
]);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

// ---- hidden admin surface (server spec §6.5) ----

const nullableIsoTimestampSchema = isoTimestampSchema.nullable();
const signedIntegerSchema = z.number().int();

export const adminOverviewSchema = z.object({
  mode: z.enum(["running", "paused"]),
  pauseCauses: z.array(z.string()),
  banner: z.string().nullable(),
  pool: z.object({
    target: nonNegativeIntegerSchema,
    active: nonNegativeIntegerSchema,
    endspiel: nonNegativeIntegerSchema,
    claimsOpen: nonNegativeIntegerSchema,
  }),
  treasury: z.object({
    usdcMicroUsdc: nonNegativeIntegerSchema,
    algoMicroAlgo: nonNegativeIntegerSchema,
    capMicroUsdc: nonNegativeIntegerSchema,
    belowRefundCoverage: z.boolean(),
  }),
  bonusAccount: z.object({
    usdcMicroUsdc: nonNegativeIntegerSchema,
    algoMicroAlgo: nonNegativeIntegerSchema,
    minAlgoMicro: nonNegativeIntegerSchema,
  }),
  payouts: z.object({
    pending: nonNegativeIntegerSchema,
    prepared: nonNegativeIntegerSchema,
    submitted: nonNegativeIntegerSchema,
    failed: nonNegativeIntegerSchema,
  }),
  funding: z.object({
    pending: nonNegativeIntegerSchema,
    prepared: nonNegativeIntegerSchema,
    submitted: nonNegativeIntegerSchema,
    failed: nonNegativeIntegerSchema,
  }),
  reconciliation: z.object({
    lastRunAt: nullableIsoTimestampSchema,
    bookMicroUsdc: signedIntegerSchema,
    chainMicroUsdc: signedIntegerSchema,
    driftMicroUsdc: signedIntegerSchema,
    inboundToleranceMicroUsdc: nonNegativeIntegerSchema,
    outboundToleranceMicroUsdc: nonNegativeIntegerSchema,
    ok: z.boolean(),
  }),
  facilitator: z.object({
    healthy: z.boolean(),
    lastCheckAt: nullableIsoTimestampSchema,
  }),
  live: z.object({
    uptimeSeconds: nonNegativeIntegerSchema,
    sseClients: nonNegativeIntegerSchema,
    settleP50Ms: z.number().nonnegative().nullable(),
    settleP95Ms: z.number().nonnegative().nullable(),
  }),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

const adminPnlItemSchema = z.object({
  address: z.string(),
  nickname: z.string(),
  pnlMicroUsdc: signedIntegerSchema,
});

export const adminActivitySchema = z.object({
  window: z.enum(["24h", "7d", "30d", "all"]),
  fromAt: nullableIsoTimestampSchema,
  toAt: isoTimestampSchema,
  counts: z.object({
    activeHumans: nonNegativeIntegerSchema,
    activeAgents: nonNegativeIntegerSchema,
    demoOnlyPlayers: nonNegativeIntegerSchema,
    registrations: nonNegativeIntegerSchema,
    humanMoves: nonNegativeIntegerSchema,
    agentMoves: nonNegativeIntegerSchema,
    demoMoves: nonNegativeIntegerSchema,
    claimsCreated: nonNegativeIntegerSchema,
    claimsMoved: nonNegativeIntegerSchema,
    claimsExpired: nonNegativeIntegerSchema,
    gamesFinished: nonNegativeIntegerSchema,
  }),
  money: z.object({
    stakeVolumeMicroUsdc: nonNegativeIntegerSchema,
    payoutVolumeMicroUsdc: nonNegativeIntegerSchema,
    protocolTakeMicroUsdc: signedIntegerSchema,
    treasuryNetFlowMicroUsdc: signedIntegerSchema,
  }),
  tripwires: z.object({
    claimMovePctHuman: z.number().nullable(),
    claimMovePctAgent: z.number().nullable(),
    demoSharePct: z.number().nullable(),
    demoToStakedPct: z.number().nullable(),
    humanMoveLatencyP50Seconds: z.number().nullable(),
    humanMoveLatencyP95Seconds: z.number().nullable(),
    quotaSaturationPct: z.number().nullable(),
    topWinners: z.array(adminPnlItemSchema),
    topLosers: z.array(adminPnlItemSchema),
  }),
});
export type AdminActivity = z.infer<typeof adminActivitySchema>;
export type AdminActivityWindow = AdminActivity["window"];

export const adminGameSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  ply: nonNegativeIntegerSchema,
  result: z.string().nullable(),
  stakePotMicroUsdc: nonNegativeIntegerSchema,
  claimsOpen: nonNegativeIntegerSchema,
  createdAt: isoTimestampSchema,
  finishedAt: nullableIsoTimestampSchema,
});
export type AdminGameSummary = z.infer<typeof adminGameSummarySchema>;

export const adminClaimSchema = z.object({
  id: z.string(),
  player: z.string(),
  nickname: z.string().nullable(),
  side: z.string(),
  demo: z.boolean(),
  status: z.string(),
  stakeMicroUsdc: nonNegativeIntegerSchema,
  move: moveSchema.nullable(),
  claimedAt: isoTimestampSchema,
  deadline: isoTimestampSchema,
  movedAt: nullableIsoTimestampSchema,
});
export type AdminClaim = z.infer<typeof adminClaimSchema>;

export const adminGameDossierSchema = z.object({
  game: adminGameSummarySchema.extend({
    fen: z.string(),
    pgn: z.string(),
    termination: z.string().nullable(),
    endspielPly: z.number().int().positive().nullable(),
    rules: z.record(z.string(), z.unknown()),
  }),
  claims: z.array(adminClaimSchema),
  stakes: z.array(
    z.object({
      id: z.string(),
      player: z.string(),
      side: z.string(),
      kind: z.string(),
      amountMicroUsdc: nonNegativeIntegerSchema,
      payTxid: z.string(),
      ply: nonNegativeIntegerSchema,
    }),
  ),
  resolution: z
    .object({
      payoutsMicroUsdc: nonNegativeIntegerSchema,
      feeMicroUsdc: signedIntegerSchema,
      dustMicroUsdc: signedIntegerSchema,
      surplusMicroUsdc: signedIntegerSchema,
      conserved: z.boolean(),
    })
    .nullable(),
  payoutJobs: z.array(
    z.object({
      id: z.string(),
      recipient: z.string(),
      amountMicroUsdc: nonNegativeIntegerSchema,
      status: z.string(),
      txid: z.string().nullable(),
      attempts: nonNegativeIntegerSchema,
    }),
  ),
});
export type AdminGameDossier = z.infer<typeof adminGameDossierSchema>;

const adminPlayerStatsSchema = z.object({
  moves: nonNegativeIntegerSchema,
  wins: nonNegativeIntegerSchema,
  draws: nonNegativeIntegerSchema,
  losses: nonNegativeIntegerSchema,
  winratePct: z.number().nullable(),
});

export const adminPlayerSummarySchema = z.object({
  address: z.string(),
  nickname: z.string().nullable(),
  kind: z.enum(["human", "agent"]),
  createdAt: isoTimestampSchema,
  lastActiveAt: isoTimestampSchema,
  banned: z.boolean(),
  deprioritizedUntil: nullableIsoTimestampSchema,
  abandonCount: nonNegativeIntegerSchema,
  points: nonNegativeIntegerSchema,
  stats: adminPlayerStatsSchema,
  netPnlMicroUsdc: signedIntegerSchema,
});
export type AdminPlayerSummary = z.infer<typeof adminPlayerSummarySchema>;
export type AdminPlayers = GamesPage<AdminPlayerSummary>;

export const adminPlayerSchema = z.object({
  address: z.string(),
  nickname: z.string().nullable(),
  kind: z.string(),
  banned: z.boolean(),
  quotaOverride: nonNegativeIntegerSchema.nullable(),
  abandonCount: nonNegativeIntegerSchema,
  deprioritizedUntil: nullableIsoTimestampSchema,
  stats: adminPlayerStatsSchema,
  netPnlMicroUsdc: signedIntegerSchema,
  points: nonNegativeIntegerSchema.optional(),
  referredBy: z.string().nullable().optional(),
  referrals: z
    .object({
      joined: nonNegativeIntegerSchema,
      qualified: nonNegativeIntegerSchema,
    })
    .optional(),
  quota: z.object({
    staked: quotaWindowSchema,
    demo: quotaWindowSchema,
  }),
  recentClaims: z.array(adminClaimSchema),
});
export type AdminPlayer = z.infer<typeof adminPlayerSchema>;

export const adminErrorSchema = z.object({
  id: nonNegativeIntegerSchema,
  at: isoTimestampSchema,
  level: z.string(),
  code: z.string(),
  requestId: z.string().nullable(),
  context: z.record(z.string(), z.unknown()),
});
export type AdminError = z.infer<typeof adminErrorSchema>;

export const adminConfigItemSchema = z.object({
  key: z.string(),
  defaultValue: z.unknown(),
  overrideValue: z.unknown().nullable(),
  effectiveValue: z.unknown(),
  description: z.string().min(1),
  effect: z.enum(["immediate", "new_claims", "new_games", "restart"]),
  editable: z.boolean(),
  updatedAt: nullableIsoTimestampSchema,
  updatedBy: z.string().nullable(),
});
export type AdminConfigItem = z.infer<typeof adminConfigItemSchema>;

export const adminConfigSchema = z.object({
  revision: nonNegativeIntegerSchema,
  items: z.array(adminConfigItemSchema),
  history: z.array(
    z.object({
      id: nonNegativeIntegerSchema,
      at: isoTimestampSchema,
      actor: z.string(),
      action: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
});
export type AdminConfig = z.infer<typeof adminConfigSchema>;

export const adminBonusSchema = z.object({
  address: z.string(),
  nickname: z.string().nullable(),
  status: z.string(),
  claimIp: z.string(),
  claimedAt: isoTimestampSchema,
  fundedAt: nullableIsoTimestampSchema,
  algoTxid: z.string().nullable(),
  usdcTxid: z.string().nullable(),
  lifetimeStakedMoves: nonNegativeIntegerSchema,
  points: nonNegativeIntegerSchema,
  referredBy: z.string().nullable(),
});
export type AdminBonus = z.infer<typeof adminBonusSchema>;

export const adminBonusesSchema = gamesPageSchema(adminBonusSchema).extend({
  todayClaimed: nonNegativeIntegerSchema,
  dailyCap: nonNegativeIntegerSchema,
  totalClaimed: nonNegativeIntegerSchema,
  totalAlgoMicro: nonNegativeIntegerSchema,
  totalUsdcMicro: nonNegativeIntegerSchema,
});
export type AdminBonuses = z.infer<typeof adminBonusesSchema>;

export const adminPauseStateSchema = z.object({
  mode: z.enum(["running", "paused"]),
  causes: z.array(z.string()),
  banner: z.string().nullable(),
});

export const adminConfigMutationSchema = z.object({
  ok: z.literal(true),
  effect: z.string(),
  revision: nonNegativeIntegerSchema,
});

// ---- x402 V2 wire shapes (rail spec §5.1/§5.2/§5.4) ----

export const paymentRequirementsSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirements = z.infer<typeof paymentRequirementsSchema>;

const bazaarObjectSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()),
    additionalProperties: z.literal(false).optional(),
  })
  .passthrough();

const bazaarExtensionSchema = z
  .object({
    info: z
      .object({
        input: z
          .object({
            type: z.literal("http"),
            method: z.literal("POST"),
            bodyType: z.literal("json"),
            body: z.object({ move: z.string() }).passthrough(),
          })
          .passthrough(),
        output: z
          .object({
            type: z.literal("json"),
            example: moveReceiptSchema,
          })
          .passthrough(),
      })
      .passthrough(),
    schema: bazaarObjectSchema.superRefine((schema, context) => {
      if (!schema.required.includes("input")) {
        context.addIssue({ code: "custom", message: "input is required" });
      }
      if (!schema.required.includes("output")) {
        context.addIssue({ code: "custom", message: "output is required" });
      }
      if (!("input" in schema.properties)) {
        context.addIssue({
          code: "custom",
          message: "input schema is missing",
        });
      }
      if (!("output" in schema.properties)) {
        context.addIssue({
          code: "custom",
          message: "output schema is missing",
        });
      }
    }),
  })
  .passthrough();

const paymentExtensionsSchema = z
  .object({ bazaar: bazaarExtensionSchema })
  .passthrough();

export const paymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({
    url: z.string(),
    description: z.string(),
    mimeType: z.literal("application/json"),
  }),
  accepts: z.array(paymentRequirementsSchema),
  extensions: paymentExtensionsSchema,
});
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>;
