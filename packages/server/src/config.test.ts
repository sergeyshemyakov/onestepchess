import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  loadServerPackageEnvironment,
  serverConfigSchema,
} from "./config.js";

const baseEnv = { RAIL: "mock" } as const;

function writeConfigFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "osc-config-"));
  const path = join(dir, "osc.config.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("server config composition", () => {
  it("zod validates the checked-in default osc.config.json", () => {
    const loaded = loadConfig({ env: baseEnv });
    expect(loaded.config.HUMAN_STAKE).toBe(10_000);
    expect(loaded.config.GAME_POOL_TARGET).toBe(8);
    expect(loaded.config.TIMER_REVEAL_SECONDS).toBe(120);
    expect(loaded.config.NEXT_GAME_NUDGE_SECONDS).toBe(20);
    expect(loaded.config.PAGE_SIZE_ACTIVE).toBe(5);
    expect(loaded.config.NONCE_TTL_SECONDS).toBe(300);
    expect(loaded.config.JWT_TTL_HOURS).toBe(24);
    expect(loaded.config.RATE_LIMIT_AUTH_PER_IP_MIN).toBe(60);
    expect(loaded.config.HUMAN_BOARD_RESERVE_PERCENT).toBe(25);
    expect(loaded.config.PAYOUT_BATCH_MAX).toBe(16);
    expect(loaded.config.BACKUP_HOUR_UTC).toBe(3);
    expect(loaded.config.CAIP2).toBe("mock:local");
    expect(loaded.config).not.toHaveProperty("ADMIN_CACHE_TTL_SECONDS");
  });

  it("rejects the retired ADMIN_CACHE_TTL_SECONDS knob as unknown", () => {
    const path = writeConfigFile({ ADMIN_CACHE_TTL_SECONDS: 60 });
    expect(() =>
      loadConfig({ env: { ...baseEnv, OSC_CONFIG_PATH: path } }),
    ).toThrowError(/ADMIN_CACHE_TTL_SECONDS: unknown key/);
  });

  it("rejects a bad knob naming the offending key", () => {
    const path = writeConfigFile({ HUMAN_STAKE: -5 });
    expect(() =>
      loadConfig({ env: { ...baseEnv, OSC_CONFIG_PATH: path } }),
    ).toThrowError(ConfigError);
    try {
      loadConfig({ env: { ...baseEnv, OSC_CONFIG_PATH: path } });
    } catch (error) {
      expect((error as ConfigError).message).toContain("HUMAN_STAKE");
    }
  });

  it("rejects an unknown key naming the offending key", () => {
    const path = writeConfigFile({ NOT_A_KNOB: 1 });
    try {
      loadConfig({ env: { ...baseEnv, OSC_CONFIG_PATH: path } });
      expect.unreachable("unknown key must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("NOT_A_KNOB");
    }
  });

  it("later-release knobs still parse with pinned defaults", () => {
    const loaded = loadConfig({ env: baseEnv });
    expect(loaded.config.BONUS_ENABLED).toBe(true);
    expect(loaded.config.BONUS_DAILY_CAP).toBe(50);
    expect(loaded.config.POINTS_MOVE).toBe(10);
    expect(loaded.config.REFERRAL_QUALIFY_MOVES).toBe(3);
    expect(loaded.config.PUBLIC_STATS_ENABLED).toBe(false);
    expect(loaded.config.GUEST_TOKEN_TTL_DAYS).toBe(30);
  });

  it("banner_flags_default_to_disabled", () => {
    const loaded = loadConfig({ env: baseEnv });
    expect(loaded.config.TOWER_BANNER_ENABLED).toBe(false);
    expect(loaded.config.CHAMP_BANNER_ENABLED).toBe(false);
  });

  it("validates the configurable human board reserve percentage", () => {
    expect(
      serverConfigSchema.parse({ HUMAN_BOARD_RESERVE_PERCENT: 0 }),
    ).toHaveProperty("HUMAN_BOARD_RESERVE_PERCENT", 0);
    expect(
      serverConfigSchema.parse({ HUMAN_BOARD_RESERVE_PERCENT: 100 }),
    ).toHaveProperty("HUMAN_BOARD_RESERVE_PERCENT", 100);
    for (const value of [-1, 25.5, 101]) {
      expect(
        serverConfigSchema.safeParse({
          HUMAN_BOARD_RESERVE_PERCENT: value,
        }).success,
      ).toBe(false);
    }
  });

  it("parses the env contract with mock defaults", () => {
    const loaded = loadConfig({
      env: {
        PORT: "4123",
        DB_PATH: "/tmp/osc-test.sqlite",
        SYSTEM_BANNER: "internal playtest — no real USDC",
      },
    });
    expect(loaded.env.RAIL).toBe("mock");
    expect(loaded.env.PORT).toBe(4123);
    expect(loaded.env.DB_PATH).toBe("/tmp/osc-test.sqlite");
    expect(loaded.env.PUBLIC_BASE_URL).toBe("http://localhost:4123");
    expect(loaded.env.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(loaded.env.SYSTEM_BANNER).toBe("internal playtest — no real USDC");
  });

  it("requires JWT_SECRET and TREASURY_MNEMONIC on the avm rail", () => {
    expect(() => loadConfig({ env: { RAIL: "avm" } })).toThrowError(
      ConfigError,
    );
    try {
      loadConfig({ env: { RAIL: "avm" } });
    } catch (error) {
      expect((error as ConfigError).message).toContain("JWT_SECRET");
    }
  });

  it("requires_telegram_bot_token_and_chat_id_together", () => {
    expect(() =>
      loadConfig({ env: { ...baseEnv, TELEGRAM_BOT_TOKEN: "123:abc" } }),
    ).toThrowError(ConfigError);
    expect(() =>
      loadConfig({ env: { ...baseEnv, TELEGRAM_CHAT_ID: "42" } }),
    ).toThrowError(ConfigError);
    const loaded = loadConfig({
      env: {
        ...baseEnv,
        TELEGRAM_BOT_TOKEN: "123:abc",
        TELEGRAM_CHAT_ID: "42",
      },
    });
    expect(loaded.env.TELEGRAM_BOT_TOKEN).toBe("123:abc");
    expect(loaded.env.TELEGRAM_CHAT_ID).toBe("42");
  });

  it("keeps an explicitly provided JWT_SECRET", () => {
    const loaded = loadConfig({
      env: { ...baseEnv, JWT_SECRET: "a".repeat(32) },
    });
    expect(loaded.env.JWT_SECRET).toBe("a".repeat(32));
  });

  it("loads_the_server_package_dotenv_with_process_values_taking_precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "osc-env-"));
    const path = join(dir, ".env");
    writeFileSync(
      path,
      [
        "ADMIN_ADDRESSES=ADMIN_ONE, ADMIN_TWO",
        "PORT=4111",
        'SYSTEM_BANNER="package env loaded"',
      ].join("\n"),
    );

    const env = loadServerPackageEnvironment({
      path,
      env: { RAIL: "mock", PORT: "4222" },
    });
    const loaded = loadConfig({ env });

    expect(loaded.env.ADMIN_ADDRESSES).toEqual(["ADMIN_ONE", "ADMIN_TWO"]);
    expect(loaded.env.PORT).toBe(4222);
    expect(loaded.env.SYSTEM_BANNER).toBe("package env loaded");
  });
});
