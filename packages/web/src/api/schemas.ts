import { z } from "zod";

const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();

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
    human: z.number(),
    agent: z.number(),
    demo: z.number(),
    windowMinutes: z.number(),
  }),
  status: z.object({
    mode: z.enum(["running", "paused"]),
    banner: z.string().nullable(),
  }),
  turnstileSiteKey: z.string(),
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

const quotaWindowSchema = z.object({
  limit: nonNegativeIntegerSchema,
  remaining: nonNegativeIntegerSchema,
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
});
export type ProfileView = z.infer<typeof profileSchema>;

export const gameResultSchema = z.enum(["white", "black", "draw", "aborted"]);
export type GameResult = z.infer<typeof gameResultSchema>;
const terminationSchema = z.enum([
  "checkmate",
  "stalemate",
  "insufficient",
  "threefold",
  "fifty_move",
  "max_plies",
  "aborted",
]);

const gameItemCommonSchema = z.object({
  yourMove: moveSchema,
  yourSide: z.enum(["white", "black"]),
  demo: z.boolean(),
  stakeMicroUsdc: nonNegativeIntegerSchema,
  claimedAt: isoTimestampSchema,
  movedAt: isoTimestampSchema,
});

/** Ongoing entries never carry game identity (I7 — CA-W2). */
export const ongoingGameItemSchema = gameItemCommonSchema.extend({
  payTxid: z.string().nullable(),
});
export type OngoingGameItem = z.infer<typeof ongoingGameItemSchema>;

export const finishedDemoItemSchema = gameItemCommonSchema.extend({
  demo: z.literal(true),
  result: gameResultSchema,
  termination: terminationSchema,
  payoutMicroUsdc: z.literal(0),
  payoutStatus: z.null(),
  statsCounted: z.literal(false),
  finishedAt: isoTimestampSchema,
});
export type FinishedDemoItem = z.infer<typeof finishedDemoItemSchema>;

export const finishedStakedItemSchema = gameItemCommonSchema.extend({
  demo: z.literal(false),
  gameId: z.string(),
  gameName: z.string(),
  finalFen: z.string(),
  result: gameResultSchema,
  termination: terminationSchema,
  yourPly: z.number().int().positive(),
  payTxid: z.string(),
  payoutMicroUsdc: nonNegativeIntegerSchema,
  payoutTxid: z.string().nullable(),
  payoutStatus: z.enum(["none", "queued", "confirmed", "failed"]),
  statsCounted: z.literal(true),
  finishedAt: isoTimestampSchema,
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
  side: z.enum(["white", "black"]),
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
  yourSide: z.enum(["white", "black"]),
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

export const paymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.string() }),
  accepts: z.array(paymentRequirementsSchema),
});
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>;
