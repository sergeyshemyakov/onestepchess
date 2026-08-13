import { z } from "zod";

const nonnegativeMoney = z.number().int().nonnegative();
const positiveMoney = z.number().int().positive();
const positiveInteger = z.number().int().positive();

const coreConfigObject = z
  .object({
    HUMAN_STAKE: positiveMoney.default(10_000),
    AGENT_STAKE: positiveMoney.default(1_000),
    ENDSPIEL_STAKE: positiveMoney.default(200),
    DRAW_FEE: nonnegativeMoney.default(0),
    PROTOCOL_FEE_BPS: z.number().int().min(0).max(10_000).default(0),
    HUMAN_TARGET_MULT: z
      .number()
      .min(1)
      .refine(
        (value) => Number(value.toFixed(2)) === value,
        "must have at most two decimal places",
      )
      .default(2),
    ENDSPIEL_PIECES: z.number().int().min(2).max(32).default(10),
    REPETITION_WIN_MARGIN: positiveInteger.default(1),
    MAX_PLIES: positiveInteger.default(300),
    MIN_PLY_INTERVAL_SECONDS: positiveInteger.default(1),
    COOLDOWN_PLIES: positiveInteger.default(6),
    CLAIM_TTL_HUMAN: positiveInteger.default(600),
    CLAIM_TTL_AGENT: positiveInteger.default(90),
    CLAIM_TTL_ENDSPIEL: positiveInteger.default(30),
    QUOTA_AGENT: positiveInteger.default(120),
    QUOTA_DEMO: positiveInteger.default(12),
    GUEST_CLAIM_ALLOWANCE: positiveInteger.default(1),
    GAME_POOL_TARGET: positiveInteger.default(8),
    STALL_ABORT_HOURS: positiveInteger.default(24),
  })
  .passthrough();

export const coreConfigSchema = coreConfigObject;

export type CoreConfig = Readonly<z.infer<typeof coreConfigSchema>>;

export const gameRulesSchema = coreConfigObject
  .pick({
    HUMAN_STAKE: true,
    AGENT_STAKE: true,
    ENDSPIEL_STAKE: true,
    DRAW_FEE: true,
    PROTOCOL_FEE_BPS: true,
    HUMAN_TARGET_MULT: true,
    ENDSPIEL_PIECES: true,
    REPETITION_WIN_MARGIN: true,
    MAX_PLIES: true,
    MIN_PLY_INTERVAL_SECONDS: true,
    COOLDOWN_PLIES: true,
    CLAIM_TTL_HUMAN: true,
    CLAIM_TTL_AGENT: true,
    CLAIM_TTL_ENDSPIEL: true,
    STALL_ABORT_HOURS: true,
  })
  .strip();

export type GameRules = Readonly<z.infer<typeof gameRulesSchema>>;
