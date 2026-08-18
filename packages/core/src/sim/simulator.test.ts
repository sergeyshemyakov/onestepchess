import { describe, expect, it } from "vitest";
import * as barrel from "../index.js";
import { P2_PROFILE, runSimulation, SimFailure } from "./simulator.js";

describe("domain simulator", () => {
  it("holds duplicate-delivery idempotency assertions", {
    timeout: 30_000,
  }, () => {
    const report = runSimulation({
      seed: 99,
      gameCount: 40,
      profile: P2_PROFILE,
    });
    expect(report.duplicateInjections).toBeGreaterThan(0);
  });

  it("produces identical event traces for two runs with one seed", {
    timeout: 30_000,
  }, () => {
    const first = runSimulation({
      seed: 424_242,
      gameCount: 25,
      profile: P2_PROFILE,
    });
    const second = runSimulation({
      seed: 424_242,
      gameCount: 25,
      profile: P2_PROFILE,
    });
    expect(second.trace).toEqual(first.trace);
  });

  it("failures carry the seed and a reproducing step trace", {
    timeout: 30_000,
  }, () => {
    let failure: SimFailure | null = null;
    try {
      runSimulation({
        seed: 7,
        gameCount: 60,
        profile: P2_PROFILE,
        bug: "dropE4",
      });
    } catch (error) {
      failure = error as SimFailure;
    }
    expect(failure).toBeInstanceOf(SimFailure);
    expect(failure?.seed).toBe(7);
    expect(failure?.message).toContain("seed=7");
    expect(failure?.traceTail.length).toBeGreaterThan(0);
  });

  it("catches a dropped E4 rule within a run", { timeout: 30_000 }, () => {
    expect(() =>
      runSimulation({
        seed: 7,
        gameCount: 60,
        profile: P2_PROFILE,
        bug: "dropE4",
      }),
    ).toThrowError(SimFailure);
  });

  it("catches a cooldown off-by-one within a run", { timeout: 30_000 }, () => {
    expect(() =>
      runSimulation({
        seed: 11,
        gameCount: 60,
        profile: P2_PROFILE,
        bug: "cooldownOffByOne",
      }),
    ).toThrowError(SimFailure);
  });

  it("catches a skipped human bonus cap within a run", {
    timeout: 60_000,
  }, () => {
    expect(() =>
      runSimulation({
        seed: 12,
        gameCount: 200,
        profile: P2_PROFILE,
        bug: "skipHumanCap",
      }),
    ).toThrowError(SimFailure);
  });

  it("keeps sim/ invisible outside the package", () => {
    const exported = Object.keys(barrel);
    expect(exported).not.toContain("runSimulation");
    expect(exported).not.toContain("SimFailure");
    expect(exported.some((name) => name.toLowerCase().includes("sim"))).toBe(
      false,
    );
  });
});
