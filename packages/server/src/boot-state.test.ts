import { createMockRail } from "@onestepchess/rail-mock";
import { describe, expect, it } from "vitest";
import { currentMode, initializeSystemState } from "./boot.js";
import { serverConfigSchema } from "./config.js";
import { openDatabase, schema } from "./db/open.js";
import { createLogger } from "./logger.js";

describe("boot system state", () => {
  it("pins identity, updates the banner, and derives durable pause mode", () => {
    const { db, sqlite } = openDatabase({ path: ":memory:" });
    const config = serverConfigSchema.parse({});
    const rail = createMockRail();
    const logger = createLogger({ level: "silent" });
    const initialize = (
      overrides: Partial<Parameters<typeof initializeSystemState>[0]> = {},
    ) =>
      initializeSystemState({
        db,
        railKind: "mock",
        config,
        treasuryAddress: rail.treasuryAddress,
        banner: undefined,
        now: 1,
        logger,
        ...overrides,
      });

    expect(initialize()).toBe(true);
    expect(db.select().from(schema.systemState).get()).toMatchObject({
      railKind: "mock",
      caip2: config.CAIP2,
      usdcAsset: config.USDC_ASA,
      treasuryAddress: rail.treasuryAddress,
      banner: null,
    });

    expect(initialize({ banner: "mock money", now: 2 })).toBe(true);
    expect(db.select().from(schema.systemState).get()?.banner).toBe(
      "mock money",
    );
    expect(currentMode(db)).toBe("running");

    db.update(schema.systemState).set({ pauseCausesJson: '["manual"]' }).run();
    expect(currentMode(db)).toBe("paused");
    sqlite.close();
  });

  it("refuses a changed network identity without mutating the pin", () => {
    const { db, sqlite } = openDatabase({ path: ":memory:" });
    const config = serverConfigSchema.parse({});
    const rail = createMockRail();
    const logger = createLogger({ level: "silent" });
    const options = {
      db,
      railKind: "mock" as const,
      config,
      treasuryAddress: rail.treasuryAddress,
      banner: undefined,
      now: 1,
      logger,
    };

    expect(initializeSystemState(options)).toBe(true);
    expect(
      initializeSystemState({
        ...options,
        config: { ...config, CAIP2: "mock:other" },
        now: 2,
      }),
    ).toBe(false);
    expect(db.select().from(schema.systemState).get()).toMatchObject({
      caip2: config.CAIP2,
      updatedAt: 1,
    });
    sqlite.close();
  });
});
