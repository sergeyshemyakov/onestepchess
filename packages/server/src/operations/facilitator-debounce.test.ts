import { createMockRail } from "@onestepchess/rail-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverConfigSchema } from "../config.js";
import { Coordinator } from "../coordinator/queue.js";
import { type OpenedDatabase, openDatabase, schema } from "../db/open.js";
import { createLogger } from "../logger.js";
import {
  OperationalState,
  probeFacilitator,
  registerOperationalCommands,
} from "./reconciliation.js";

const databases: OpenedDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

function setup(now: () => number = () => 1_000) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  database.db
    .insert(schema.systemState)
    .values({
      id: 1,
      railKind: "mock",
      caip2: "mock:local",
      usdcAsset: "0",
      treasuryAddress: "TREASURY",
      pauseCausesJson: "[]",
      updatedAt: 0,
    })
    .run();
  const rail = createMockRail();
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    now: () => 1_000,
  });
  const emit = vi.fn(async () => true);
  const recordRailUnhealthySeconds = vi.fn();
  const deps = {
    coordinator,
    db: database.db,
    rail,
    config: () => serverConfigSchema.parse({}),
    now,
    state: new OperationalState(),
    alerts: { emit } as never,
    metrics: { recordRailUnhealthySeconds },
  };
  registerOperationalCommands(deps);
  return { database, rail, deps, emit, recordRailUnhealthySeconds };
}

function pauseCauses(database: OpenedDatabase): string[] {
  return JSON.parse(
    database.db.select().from(schema.systemState).get()?.pauseCausesJson ??
      "[]",
  ) as string[];
}

function alertsOfType(emit: ReturnType<typeof vi.fn>, type: string): number {
  return emit.mock.calls.filter(([name]) => name === type).length;
}

describe("Server robustness F6 — facilitator alert debounce (spec 2026-08-26)", () => {
  it("single_probe_blip_pauses_immediately_but_emits_no_alert", async () => {
    const { database, rail, deps, emit } = setup();
    rail.control.setHealth(false);
    await probeFacilitator(deps);
    expect(pauseCauses(database)).toContain("facilitator");
    rail.control.setHealth(true);
    await probeFacilitator(deps);
    expect(pauseCauses(database)).not.toContain("facilitator");
    expect(alertsOfType(emit, "facilitator_unhealthy")).toBe(0);
    expect(alertsOfType(emit, "facilitator_recovered")).toBe(0);
  });

  it("three_consecutive_failures_alert_once_and_recovery_alerts_once", async () => {
    const { rail, deps, emit } = setup();
    rail.control.setHealth(false);
    for (let i = 0; i < 5; i += 1) {
      await probeFacilitator(deps);
    }
    expect(alertsOfType(emit, "facilitator_unhealthy")).toBe(1);
    rail.control.setHealth(true);
    await probeFacilitator(deps);
    await probeFacilitator(deps);
    expect(alertsOfType(emit, "facilitator_recovered")).toBe(1);
  });

  it("recovery_records_the_unhealthy_stretch_in_seconds", async () => {
    let now = 10_000;
    const { rail, deps, recordRailUnhealthySeconds } = setup(() => now);
    rail.control.setHealth(false);
    await probeFacilitator(deps);
    now = 100_000;
    rail.control.setHealth(true);
    await probeFacilitator(deps);
    expect(recordRailUnhealthySeconds).toHaveBeenCalledTimes(1);
    expect(recordRailUnhealthySeconds).toHaveBeenCalledWith(90);
  });
});
