import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { coreConfigSchema } from "@onestepchess/core";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(
    readonly keys: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function fromZodError(error: z.ZodError, source: string): ConfigError {
  const keys = new Set<string>();
  const details: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        keys.add(key);
        details.push(`${key}: unknown key`);
      }
      continue;
    }
    const key = issue.path.map(String).join(".") || "(root)";
    keys.add(key);
    details.push(`${key}: ${issue.message}`);
  }
  return new ConfigError([...keys], `invalid ${source}: ${details.join("; ")}`);
}

const positiveInt = z.number().int().positive();
const nonnegativeInt = z.number().int().nonnegative();
const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}, "must be an HTTP(S) origin without credentials, query, or fragment");
const walletRelayUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "wss:") &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}, "must be a secure HTTP or WebSocket origin");

// Server-owned knobs per server spec §5. Knobs whose feature lands in a later
// release still parse here — the config file contract is stable from S1 on.
export const serverConfigSchema = coreConfigSchema
  .extend({
    TIMER_REVEAL_SECONDS: positiveInt.default(120),
    NEXT_GAME_NUDGE_SECONDS: positiveInt.default(20),
    PAGE_SIZE_ACTIVE: positiveInt.default(5),
    PAGE_SIZE_FINISHED: positiveInt.default(10),
    NONCE_TTL_SECONDS: positiveInt.default(300),
    JWT_TTL_HOURS: positiveInt.default(24),
    NICKNAME_CHANGES_PER_DAY: positiveInt.default(3),
    ABANDON_THRESHOLD: positiveInt.default(6),
    DEPRIORITIZE_HOURS: positiveInt.default(24),
    PAYMENT_RECOVERY_TIMEOUT_SECONDS: positiveInt.default(180),
    RATE_LIMIT_AUTH_PER_IP_MIN: positiveInt.default(10),
    RATE_LIMIT_CLAIMS_PER_IP_MIN: positiveInt.default(30),
    HUMAN_BOARD_RESERVE_PERCENT: z.number().int().min(0).max(100).default(25),
    SSE_HEARTBEAT_SECONDS: positiveInt.default(25),
    SSE_MAX_CONNECTIONS_PER_PLAYER: positiveInt.default(4),
    EVENTS_RETENTION_DAYS: positiveInt.default(7),
    ADMIN_CACHE_TTL_SECONDS: positiveInt.default(60),
    PAYOUT_BATCH_MAX: positiveInt.default(16),
    PAYOUT_MAX_ATTEMPTS: positiveInt.default(10),
    RECONCILE_INTERVAL_MINUTES: positiveInt.default(60),
    BACKUP_HOUR_UTC: z.number().int().min(0).max(23).default(3),
    BACKUP_RETENTION_DAYS: positiveInt.default(7),
    TREASURY_CAP_MICROUSDC: positiveInt.default(50_000_000),
    TREASURY_MIN_ALGO_MICRO: positiveInt.default(1_000_000),
    ALERT_DEDUPE_SECONDS: positiveInt.default(60),
    TURNSTILE_SITE_KEY: z.string().default(""),
    GUEST_TOKEN_TTL_DAYS: positiveInt.default(30),
    BONUS_ENABLED: z.boolean().default(true),
    BONUS_ALGO_MICRO: positiveInt.default(250_000),
    BONUS_USDC_MICRO: positiveInt.default(200_000),
    BONUS_DAILY_CAP: positiveInt.default(50),
    BONUS_MAX_ATTEMPTS: positiveInt.default(10),
    BONUS_WATCH_INTERVAL_SECONDS: positiveInt.default(60),
    POINTS_MOVE: nonnegativeInt.default(10),
    POINTS_WIN: nonnegativeInt.default(15),
    REFERRAL_QUALIFY_MOVES: positiveInt.default(3),
    REFERRAL_POINTS: nonnegativeInt.default(50),
    PUBLIC_STATS_ENABLED: z.boolean().default(false),
    TOWER_BANNER_ENABLED: z.boolean().default(false),
    CHAMP_BANNER_ENABLED: z.boolean().default(false),
    CARD_CACHE_MAX: positiveInt.default(200),
    CAIP2: z.string().min(1).default("mock:local"),
    USDC_ASA: z
      .string()
      .regex(/^\d+$/, "must be a stringified ASA id")
      .default("31566704"),
    ALGOD_URL: httpUrl.default("http://localhost:4001"),
    // Reviewed WalletConnect relay origin for the CSP connect-src (server spec
    // §6.6); no wildcard is allowed, so this is an exact origin.
    WALLETCONNECT_RELAY_URL: walletRelayUrl.default(
      "wss://relay.walletconnect.org",
    ),
    INDEXER_URL: httpUrl.default("http://localhost:8980"),
    FACILITATOR_URL: httpUrl.default("http://localhost:4402"),
    EXPLORER_BASE_URL: httpUrl.default("https://explorer.perawallet.app"),
  })
  .strict();

export type ServerConfig = Readonly<z.infer<typeof serverConfigSchema>>;

const railSchema = z.enum(["mock", "avm"]);

const envSchema = z.object({
  RAIL: railSchema.default("mock"),
  DB_PATH: z.string().min(1).default("osc.sqlite"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  PUBLIC_BASE_URL: z.url().optional(),
  JWT_SECRET: z.string().min(16).optional(),
  ADMIN_TOKEN: z.string().min(1).optional(),
  ADMIN_ADDRESSES: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((address) => address.trim())
        .filter((address) => address.length > 0),
    )
    .default([]),
  TREASURY_MNEMONIC: z.string().min(1).optional(),
  TURNSTILE_SECRET: z.string().min(1).optional(),
  SYSTEM_BANNER: z.string().min(1).optional(),
  ALERT_WEBHOOK_URL: z.url().optional(),
  BACKUP_DIR: z.string().min(1).optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  OSC_CONFIG_PATH: z.string().min(1).optional(),
  CAIP2: z.string().min(1).optional(),
  USDC_ASA: z.string().regex(/^\d+$/).optional(),
  ALGOD_URL: z.url().optional(),
  INDEXER_URL: z.url().optional(),
  FACILITATOR_URL: z.url().optional(),
  EXPLORER_BASE_URL: z.url().optional(),
  WALLETCONNECT_RELAY_URL: z.url().optional(),
});

export type ServerEnv = Readonly<
  Omit<z.infer<typeof envSchema>, "JWT_SECRET" | "PUBLIC_BASE_URL"> & {
    JWT_SECRET: string;
    PUBLIC_BASE_URL: string;
  }
>;

export type LoadedConfig = {
  readonly config: ServerConfig;
  readonly env: ServerEnv;
  readonly configPath: string | null;
};

const SERVER_PACKAGE_ENV_PATH = fileURLToPath(
  new URL("../.env", import.meta.url),
);

export function loadServerPackageEnvironment(
  options: {
    readonly path?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Readonly<Record<string, string | undefined>> {
  const runtime = options.env ?? process.env;
  const path = options.path ?? SERVER_PACKAGE_ENV_PATH;
  if (!existsSync(path)) return runtime;
  const packageEnv = parseEnv(readFileSync(path, "utf8"));
  return { ...packageEnv, ...runtime };
}

function resolveConfigPath(explicit: string | undefined): string | null {
  if (explicit !== undefined) {
    if (!existsSync(explicit)) {
      throw new ConfigError(
        ["OSC_CONFIG_PATH"],
        `invalid env: OSC_CONFIG_PATH: no config file at ${explicit}`,
      );
    }
    return explicit;
  }
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "osc.config.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function readConfigFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      ["OSC_CONFIG_PATH"],
      `invalid config file ${path}: ${(error as Error).message}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      ["OSC_CONFIG_PATH"],
      `invalid config file ${path}: ${(error as Error).message}`,
    );
  }
}

export function loadConfig(
  options: { readonly env?: Readonly<Record<string, string | undefined>> } = {},
): LoadedConfig {
  const rawEnv = options.env ?? process.env;
  const envResult = envSchema.safeParse(rawEnv);
  if (!envResult.success) {
    throw fromZodError(envResult.error, "env");
  }
  const parsedEnv = envResult.data;

  if (parsedEnv.RAIL === "avm") {
    const missing = (["JWT_SECRET", "TREASURY_MNEMONIC"] as const).filter(
      (key) => parsedEnv[key] === undefined,
    );
    if (missing.length > 0) {
      throw new ConfigError(
        missing,
        `invalid env: ${missing.join(", ")} required when RAIL=avm`,
      );
    }
  }

  const configPath = resolveConfigPath(parsedEnv.OSC_CONFIG_PATH);
  const fileContents = configPath === null ? {} : readConfigFile(configPath);
  const networkEnv = Object.fromEntries(
    (
      [
        "CAIP2",
        "USDC_ASA",
        "ALGOD_URL",
        "INDEXER_URL",
        "FACILITATOR_URL",
        "EXPLORER_BASE_URL",
        "WALLETCONNECT_RELAY_URL",
      ] as const
    ).flatMap((key) =>
      parsedEnv[key] === undefined ? [] : [[key, parsedEnv[key]] as const],
    ),
  );
  const configResult = serverConfigSchema.safeParse({
    ...(fileContents as Record<string, unknown>),
    ...networkEnv,
  });
  if (!configResult.success) {
    throw fromZodError(configResult.error, "config");
  }
  if (
    parsedEnv.RAIL === "avm" &&
    !/^algorand:[A-Za-z0-9+/]{43}=$/.test(configResult.data.CAIP2)
  ) {
    throw new ConfigError(
      ["CAIP2"],
      "invalid config: CAIP2 must be a complete Algorand CAIP-2 id when RAIL=avm",
    );
  }

  return {
    config: configResult.data,
    env: {
      ...parsedEnv,
      // The mock profile is dev/CI only; an ephemeral per-boot secret keeps
      // clean checkouts bootable without weakening the avm requirement.
      JWT_SECRET: parsedEnv.JWT_SECRET ?? randomBytes(32).toString("hex"),
      PUBLIC_BASE_URL:
        parsedEnv.PUBLIC_BASE_URL ?? `http://localhost:${parsedEnv.PORT}`,
    },
    configPath,
  };
}

/** Persisted admin overrides overlay the file config (server spec §5).
 * Release 1 ships no admin mutation surface, so this reads zero rows — but
 * the overlay point in the boot order is pinned from S1 on. */
export function applyConfigOverrides(
  config: ServerConfig,
  rows: readonly { readonly key: string; readonly valueJson: string }[],
): ServerConfig {
  if (rows.length === 0) {
    return config;
  }
  const merged: Record<string, unknown> = { ...config };
  for (const row of rows) {
    merged[row.key] = JSON.parse(row.valueJson);
  }
  const result = serverConfigSchema.safeParse(merged);
  if (!result.success) {
    throw fromZodError(result.error, "config overrides");
  }
  return result.data;
}

export function secretValues(env: ServerEnv): readonly string[] {
  return [
    env.JWT_SECRET,
    env.ADMIN_TOKEN,
    env.TREASURY_MNEMONIC,
    env.TURNSTILE_SECRET,
  ].filter((value): value is string => value !== undefined && value.length > 0);
}
