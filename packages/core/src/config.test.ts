import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CoreConfig, GameRules } from "./config.js";
import { coreConfigSchema, gameRulesSchema } from "./config.js";

const DEFAULTS = {
  HUMAN_STAKE: 10_000,
  AGENT_STAKE: 1_000,
  ENDSPIEL_STAKE: 200,
  DRAW_FEE: 0,
  PROTOCOL_FEE_BPS: 0,
  HUMAN_TARGET_MULT: 2,
  ENDSPIEL_PIECES: 10,
  REPETITION_WIN_MARGIN: 3,
  MAX_PLIES: 300,
  MIN_PLY_INTERVAL_SECONDS: 20,
  COOLDOWN_PLIES: 6,
  CLAIM_TTL_HUMAN: 600,
  CLAIM_TTL_AGENT: 90,
  CLAIM_TTL_ENDSPIEL: 30,
  QUOTA_HUMAN: 12,
  QUOTA_AGENT: 120,
  QUOTA_DEMO: 12,
  GUEST_CLAIM_ALLOWANCE: 1,
  GAME_POOL_TARGET: 8,
  STALL_ABORT_HOURS: 24,
} as const;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;
type ReadonlyCoreConfig = Assert<Equal<CoreConfig, Readonly<CoreConfig>>>;
type ReadonlyGameRules = Assert<Equal<GameRules, Readonly<GameRules>>>;
const readonlyTypeAssertions: [ReadonlyCoreConfig, ReadonlyGameRules] = [
  true,
  true,
];

describe("core configuration", () => {
  it("defaults parse to exactly the pinned core table values", () => {
    expect(coreConfigSchema.parse({})).toEqual(DEFAULTS);
  });

  it.each([
    ["HUMAN_STAKE", 0],
    ["AGENT_STAKE", 0],
    ["ENDSPIEL_STAKE", 0],
    ["DRAW_FEE", -1],
    ["PROTOCOL_FEE_BPS", -1],
    ["PROTOCOL_FEE_BPS", 10_001],
    ["PROTOCOL_FEE_BPS", 0.5],
    ["HUMAN_TARGET_MULT", 0.99],
    ["HUMAN_TARGET_MULT", 1.001],
    ["ENDSPIEL_PIECES", 1],
    ["ENDSPIEL_PIECES", 33],
    ["REPETITION_WIN_MARGIN", 0],
    ["MAX_PLIES", 0],
    ["MIN_PLY_INTERVAL_SECONDS", 0],
    ["COOLDOWN_PLIES", 0],
    ["CLAIM_TTL_HUMAN", 0],
    ["CLAIM_TTL_AGENT", 0],
    ["CLAIM_TTL_ENDSPIEL", 0],
    ["QUOTA_HUMAN", 0],
    ["QUOTA_AGENT", 0],
    ["QUOTA_DEMO", 0],
    ["GUEST_CLAIM_ALLOWANCE", 0],
    ["GAME_POOL_TARGET", 0],
    ["STALL_ABORT_HOURS", 0],
  ] as const)("rejects the pinned validation rule for %s=%s", (key, value) => {
    expect(coreConfigSchema.safeParse({ [key]: value }).success).toBe(false);
  });

  it("passes unknown keys and supports strict server-side extension", () => {
    expect(coreConfigSchema.parse({ SERVER_ONLY: "kept" })).toMatchObject({
      SERVER_ONLY: "kept",
    });
    const serverSchema = coreConfigSchema
      .extend({ PORT: z.number().int() })
      .strict();
    expect(serverSchema.parse({ ...DEFAULTS, PORT: 3000 })).toEqual({
      ...DEFAULTS,
      PORT: 3000,
    });
  });

  it("gameRulesSchema contains exactly the pinned keys and round-trips JSON", () => {
    const expectedKeys = [
      "HUMAN_STAKE",
      "AGENT_STAKE",
      "ENDSPIEL_STAKE",
      "DRAW_FEE",
      "PROTOCOL_FEE_BPS",
      "HUMAN_TARGET_MULT",
      "ENDSPIEL_PIECES",
      "REPETITION_WIN_MARGIN",
      "MAX_PLIES",
      "MIN_PLY_INTERVAL_SECONDS",
      "COOLDOWN_PLIES",
      "CLAIM_TTL_HUMAN",
      "CLAIM_TTL_AGENT",
      "CLAIM_TTL_ENDSPIEL",
      "STALL_ABORT_HOURS",
    ];
    expect(Object.keys(gameRulesSchema.shape)).toEqual(expectedKeys);
    const rules = gameRulesSchema.parse(DEFAULTS);
    expect(Object.keys(rules)).toEqual(expectedKeys);
    expect(gameRulesSchema.parse(JSON.parse(JSON.stringify(rules)))).toEqual(
      rules,
    );
    expect(readonlyTypeAssertions).toEqual([true, true]);
  });
});
