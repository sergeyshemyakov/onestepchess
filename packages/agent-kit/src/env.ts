import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

const envSchema = z.object({
  OSC_SERVER_URL: z.url(),
  OSC_KEYFILE: z.string().min(1).optional(),
  OSC_MNEMONIC: z.string().min(1).optional(),
  OSC_ALGOD_URL: z.url().optional(),
  OSC_MAX_STAKE_MICROUSDC: positiveIntegerString.default(5_000),
  OSC_SESSION_BUDGET_MICROUSDC: positiveIntegerString.default(100_000),
  OSC_FORMATS: z.string().default("ascii,fen"),
  OSC_BOARD_DIR: z.string().min(1).optional(),
  OSC_NICKNAME: z.string().min(1).optional(),
  OSC_EXPECT_NETWORK: z.enum(["mainnet", "testnet", "mock"]).optional(),
  OSC_DEBUG: z.literal("1").optional(),
});

export type OscEnv = {
  readonly serverUrl: string;
  readonly keyfile: string;
  readonly mnemonic?: string;
  readonly algodUrl?: string;
  readonly maxStakeMicroUsdc: number;
  readonly sessionBudgetMicroUsdc: number;
  readonly formats: string[];
  readonly boardDir?: string;
  readonly nickname?: string;
  readonly expectNetwork?: "mainnet" | "testnet" | "mock";
  readonly debug: boolean;
};

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): OscEnv {
  const parsed = envSchema.parse(source);
  return {
    serverUrl: parsed.OSC_SERVER_URL,
    keyfile: parsed.OSC_KEYFILE ?? join(homedir(), ".osc", "keyfile.json"),
    maxStakeMicroUsdc: parsed.OSC_MAX_STAKE_MICROUSDC,
    sessionBudgetMicroUsdc: parsed.OSC_SESSION_BUDGET_MICROUSDC,
    formats: parsed.OSC_FORMATS.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    debug: parsed.OSC_DEBUG === "1",
    ...(parsed.OSC_MNEMONIC === undefined
      ? {}
      : { mnemonic: parsed.OSC_MNEMONIC }),
    ...(parsed.OSC_ALGOD_URL === undefined
      ? {}
      : { algodUrl: parsed.OSC_ALGOD_URL }),
    ...(parsed.OSC_BOARD_DIR === undefined
      ? {}
      : { boardDir: parsed.OSC_BOARD_DIR }),
    ...(parsed.OSC_NICKNAME === undefined
      ? {}
      : { nickname: parsed.OSC_NICKNAME }),
    ...(parsed.OSC_EXPECT_NETWORK === undefined
      ? {}
      : { expectNetwork: parsed.OSC_EXPECT_NETWORK }),
  };
}
