import { z } from "zod";

const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

export const sideSchema = z.enum(["white", "black"]);
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

const claimViewBaseSchema = z.object({
  claimId: z.string(),
  yourSide: sideSchema,
  phase: z.enum(["normal", "endspiel"]),
  demo: z.boolean(),
  fen: z.string(),
  legalMoves: z.array(moveSchema),
  stakeMicroUsdc: nonNegativeIntegerSchema,
  deadline: isoTimestampSchema,
  board: z.string().optional(),
});

const forbiddenClaimFields = ["gameId", "name", "ply", "history"] as const;
export const claimViewSchema = claimViewBaseSchema
  .passthrough()
  .superRefine((value, context) => {
    for (const field of forbiddenClaimFields) {
      if (Object.hasOwn(value, field)) {
        context.addIssue({
          code: "custom",
          message: `ClaimView must not expose ${field}`,
          path: [field],
        });
      }
    }
  })
  .transform((value) => claimViewBaseSchema.parse(value));
export type ClaimView = z.infer<typeof claimViewSchema>;

export const moveReceiptSchema = z.object({
  status: z.literal("moved"),
  move: moveSchema,
  debitMicroUsdc: nonNegativeIntegerSchema,
  txid: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  fenAfterYourMove: z.string(),
});
export type MoveReceipt = z.infer<typeof moveReceiptSchema>;

export const claimStatusViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("open"),
    claim: claimViewSchema,
    paymentState: z.enum(["verifying", "settling"]).nullable(),
  }),
  z.object({ status: z.literal("moved"), receipt: moveReceiptSchema }),
  z.object({ status: z.literal("expired") }),
]);
export type ClaimStatusView = z.infer<typeof claimStatusViewSchema>;

const gameResultSchema = z.enum(["white", "black", "draw", "aborted"]);
const terminationSchema = z.enum([
  "checkmate",
  "stalemate",
  "insufficient",
  "threefold",
  "fifty_move",
  "max_plies",
  "aborted",
]);
const repetitionAdjudicationSchema = z
  .object({
    whiteMaterialPoints: nonNegativeIntegerSchema,
    blackMaterialPoints: nonNegativeIntegerSchema,
    winMargin: positiveIntegerSchema,
  })
  .nullable();

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

const finishedDemoGameItemSchema = finishedGameItemCommonSchema.extend({
  demo: z.literal(true),
  yourMoves: z.array(moveSchema).min(1),
  payoutMicroUsdc: z.literal(0),
  payoutStatus: z.null(),
  statsCounted: z.literal(false),
});

const finishedStakedGameItemSchema = finishedGameItemCommonSchema.extend({
  demo: z.literal(false),
  gameId: z.string(),
  gameName: z.string(),
  finalFen: z.string(),
  yourMoves: z.array(moveSchema.extend({ ply: positiveIntegerSchema })).min(1),
  payTxid: z.string().nullable(),
  payoutMicroUsdc: nonNegativeIntegerSchema,
  payoutTxid: z.string().nullable(),
  payoutStatus: z.enum(["none", "queued", "confirmed", "failed"]),
  statsCounted: z.literal(true),
});

export const finishedGameItemSchema = z.discriminatedUnion("demo", [
  finishedDemoGameItemSchema,
  finishedStakedGameItemSchema,
]);
type FinishedGameItemWire = z.infer<typeof finishedGameItemSchema>;
export type FinishedGameItem = FinishedGameItemWire & {
  readonly outcome: "win" | "loss" | "draw" | "aborted";
};

export function pageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    page: positiveIntegerSchema,
    pageCount: nonNegativeIntegerSchema,
    total: nonNegativeIntegerSchema,
  });
}
export type Page<T> = {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
};

export const replayViewSchema = z.object({
  gameId: z.string(),
  name: z.string(),
  result: gameResultSchema,
  termination: terminationSchema,
  repetitionAdjudication: repetitionAdjudicationSchema,
  endspielPly: positiveIntegerSchema.nullable(),
  createdAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  plies: z.array(
    z.object({
      ply: positiveIntegerSchema,
      side: sideSchema,
      move: moveSchema,
      fenAfter: z.string(),
      author: z.object({
        nickname: z.string().nullable(),
        kind: z.enum(["human", "agent", "guest"]),
        winratePct: z.number().min(0).max(100).nullable(),
      }),
      stakeMicroUsdc: nonNegativeIntegerSchema,
      demo: z.boolean(),
    }),
  ),
  pgn: z.string(),
});
export type ReplayView = z.infer<typeof replayViewSchema>;

const playerSchema = z.object({
  address: z.string(),
  kind: z.enum(["human", "agent"]),
  nickname: z.string().nullable(),
  createdAt: isoTimestampSchema,
});

// A null limit/remaining means the window is uncapped (staked human claims).
const quotaSchema = z.object({
  limit: nonNegativeIntegerSchema.nullable(),
  remaining: nonNegativeIntegerSchema.nullable(),
  resetsAt: isoTimestampSchema.nullable(),
});

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
  quotas: z.object({ staked: quotaSchema, demo: quotaSchema }),
  deprioritizedUntil: isoTimestampSchema.nullable(),
});
export type Profile = z.infer<typeof profileSchema>;

export const metaSchema = z.object({
  name: z.string(),
  network: z.object({
    caip2: z.string(),
    usdcAssetId: z.string(),
    treasuryAddress: z.string(),
    facilitatorUrl: z.string(),
    explorerBaseUrl: z.string(),
    algodUrl: z.string().optional(),
  }),
  economics: z.object({
    humanStakeMicroUsdc: nonNegativeIntegerSchema,
    agentStakeMicroUsdc: nonNegativeIntegerSchema,
    endspielStakeMicroUsdc: nonNegativeIntegerSchema,
    drawFeeMicroUsdc: nonNegativeIntegerSchema,
    protocolFeeBps: nonNegativeIntegerSchema,
    humanTargetMult: z.number().nonnegative(),
  }),
  timing: z.object({
    claimTtlSeconds: z.object({
      human: positiveIntegerSchema,
      agent: positiveIntegerSchema,
      endspiel: positiveIntegerSchema,
    }),
    timerRevealSeconds: nonNegativeIntegerSchema,
    minPlyIntervalSeconds: nonNegativeIntegerSchema,
    cooldownPlies: nonNegativeIntegerSchema,
    nextGameNudgeSeconds: nonNegativeIntegerSchema,
  }),
  quotas: z.object({
    human: nonNegativeIntegerSchema.nullable(),
    agent: nonNegativeIntegerSchema,
    demo: nonNegativeIntegerSchema,
    windowMinutes: positiveIntegerSchema,
  }),
  pool: z
    .object({
      target: nonNegativeIntegerSchema,
      active: nonNegativeIntegerSchema,
      endspiel: nonNegativeIntegerSchema,
    })
    .optional(),
  status: z.object({
    mode: z.enum(["running", "paused"]),
    banner: z.string().nullable(),
  }),
  turnstileSiteKey: z.string(),
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
    // Older servers omit it; the client must keep parsing their /meta.
    botRepo: z.string().optional(),
    repo: z.string(),
  }),
});
export type Meta = z.infer<typeof metaSchema>;

export const challengeResponseSchema = z.object({
  nonce: z.string(),
  expiresAt: isoTimestampSchema,
  arc60Payload: z.object({
    data: z.string(),
    metadata: z.object({
      scope: z.literal(1),
      encoding: z.literal("base64"),
    }),
  }),
  fallbackTxnB64: z.string(),
});
export type ChallengeResponse = z.infer<typeof challengeResponseSchema>;

export const verifyResponseSchema = z.object({
  player: playerSchema,
  jwt: z.string(),
  linkedGuestClaims: nonNegativeIntegerSchema.optional(),
});
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;

export const paymentRequirementsSchema = z.object({
  scheme: z.enum(["exact", "mock"]),
  network: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string(),
  maxTimeoutSeconds: positiveIntegerSchema,
  extra: z.record(z.string(), z.unknown()),
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
    url: z.url(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  accepts: z.array(paymentRequirementsSchema).length(1),
  extensions: paymentExtensionsSchema,
});
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>;

export const paymentResponseSchema = z.object({
  success: z.literal(true),
  transaction: z.string(),
  network: z.string(),
});

export function deriveOutcome(
  item: FinishedGameItemWire,
): FinishedGameItem["outcome"] {
  if (item.result === "draw" || item.result === "aborted") return item.result;
  return item.result === item.yourSide ? "win" : "loss";
}
