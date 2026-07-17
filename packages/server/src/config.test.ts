import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

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
    expect(loaded.config.NONCE_TTL_SECONDS).toBe(300);
    expect(loaded.config.JWT_TTL_HOURS).toBe(24);
    expect(loaded.config.RATE_LIMIT_AUTH_PER_IP_MIN).toBe(10);
    expect(loaded.config.PAYOUT_BATCH_MAX).toBe(16);
    expect(loaded.config.BACKUP_HOUR_UTC).toBe(3);
    expect(loaded.config.CAIP2).toBe("mock:local");
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

  it("keeps an explicitly provided JWT_SECRET", () => {
    const loaded = loadConfig({
      env: { ...baseEnv, JWT_SECRET: "a".repeat(32) },
    });
    expect(loaded.env.JWT_SECRET).toBe("a".repeat(32));
  });
});
