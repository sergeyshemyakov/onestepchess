import { RailError } from "@onestepchess/core";
import { createMockRail } from "@onestepchess/rail-mock";
import { describe, expect, it, vi } from "vitest";
import { createGuardedRail } from "./guard.js";

function setup(options: { maxConcurrent?: number; reserved?: number } = {}) {
  const inner = createMockRail();
  let now = 1_000_000;
  const guard = createGuardedRail({
    rail: inner,
    now: () => now,
    maxConcurrent: () => options.maxConcurrent ?? 16,
    ...(options.reserved === undefined
      ? {}
      : { reservedPriority: options.reserved }),
  });
  return {
    inner,
    guard,
    advance(ms: number) {
      now += ms;
    },
  };
}

function unavailable(): never {
  throw new RailError("UNAVAILABLE", "Chain query unavailable");
}

describe("Server robustness F2 — per-dependency rail circuit breaker (spec 2026-08-26)", () => {
  it("algod_breaker_opens_after_three_consecutive_failures_and_fails_fast", async () => {
    const { inner, guard } = setup();
    const balances = vi
      .spyOn(inner, "getBalances")
      .mockImplementation(async () => unavailable());
    for (let i = 0; i < 3; i += 1) {
      await expect(guard.rail.getBalances("A")).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
    }
    await expect(guard.rail.getBalances("A")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(balances).toHaveBeenCalledTimes(3);
    // The facilitator dependency is unaffected by the algod breaker.
    await expect(guard.rail.health()).resolves.toBe(true);
  });

  it("facilitator_probe_success_does_not_close_the_algod_breaker", async () => {
    const { inner, guard } = setup();
    const balances = vi
      .spyOn(inner, "getBalances")
      .mockImplementation(async () => unavailable());
    for (let i = 0; i < 3; i += 1) {
      await guard.rail.getBalances("A").catch(() => {});
    }
    await expect(guard.rail.health()).resolves.toBe(true);
    await expect(guard.rail.getBalances("A")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(balances).toHaveBeenCalledTimes(3);
    expect(guard.state().algod.open).toBe(true);
    expect(guard.state().facilitator.open).toBe(false);
  });

  it("priority_canary_reaches_through_the_open_breaker_and_success_closes_it", async () => {
    const { inner, guard } = setup();
    const balances = vi
      .spyOn(inner, "getBalances")
      .mockImplementation(async () => unavailable());
    for (let i = 0; i < 3; i += 1) {
      await guard.rail.getBalances("A").catch(() => {});
    }
    balances.mockRestore();
    await expect(guard.priorityRail.getBalances("A")).resolves.toMatchObject({
      usdcMicroUsdc: expect.any(Number),
    });
    expect(guard.state().algod.open).toBe(false);
    await expect(guard.rail.getBalances("A")).resolves.toBeTruthy();
  });

  it("concurrency_cap_rejects_excess_calls_but_reserves_priority_capacity", async () => {
    const { inner, guard } = setup({ maxConcurrent: 3, reserved: 2 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const balances = vi
      .spyOn(inner, "getBalances")
      .mockImplementation(async () => {
        await gate;
        return { usdcMicroUsdc: 0, algoMicroAlgo: 0 };
      });
    const first = guard.rail.getBalances("A");
    await expect(guard.rail.getBalances("B")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    const priority = guard.priorityRail.getBalances("C");
    release();
    await expect(first).resolves.toBeTruthy();
    await expect(priority).resolves.toBeTruthy();
    expect(balances).toHaveBeenCalledTimes(2);
  });

  it("saturation_rejections_do_not_trip_the_breaker", async () => {
    const { inner, guard } = setup({ maxConcurrent: 2, reserved: 1 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(inner, "getBalances").mockImplementation(async () => {
      await gate;
      return { usdcMicroUsdc: 0, algoMicroAlgo: 0 };
    });
    const held = guard.rail.getBalances("A");
    for (let i = 0; i < 5; i += 1) {
      await guard.rail.getBalances("B").catch(() => {});
    }
    expect(guard.state().algod.open).toBe(false);
    release();
    await held;
  });
});

describe("Guard over a frozen rail — createAvmRail freezes its instance", () => {
  it("frozen_rail_methods_and_properties_work_through_both_guard_handles", async () => {
    // Proxy get-trap invariant: a frozen target's data properties must be
    // returned verbatim, so the guard must not proxy the rail object itself
    // (2026-08-27 outage: every guarded call threw TypeError before I/O).
    const inner = Object.freeze(createMockRail());
    const guard = createGuardedRail({
      rail: inner,
      now: () => 1_000_000,
      maxConcurrent: () => 16,
    });
    await expect(guard.rail.health()).resolves.toBe(true);
    await expect(
      guard.priorityRail.getBalances(inner.treasuryAddress),
    ).resolves.toMatchObject({ usdcMicroUsdc: expect.any(Number) });
    expect(guard.rail.treasuryAddress).toBe(inner.treasuryAddress);
  });
});

describe("Server robustness F2 review fixes — outcome classification and provenance", () => {
  it("in_band_unavailable_results_trip_the_breaker", async () => {
    const { inner, guard } = setup();
    const health = vi.spyOn(inner, "health").mockResolvedValue(false);
    for (let i = 0; i < 3; i += 1) {
      await expect(guard.rail.health()).resolves.toBe(false);
    }
    expect(guard.state().facilitator.open).toBe(true);
    await expect(guard.rail.health()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(health).toHaveBeenCalledTimes(3);
    const submit = vi
      .spyOn(inner, "submitPrepared")
      .mockResolvedValue({ ok: false, reason: "unavailable" });
    for (let i = 0; i < 3; i += 1) {
      await guard.rail
        .submitPrepared({ kind: "funding" } as never)
        .catch(() => {});
    }
    expect(guard.state().algod.open).toBe(true);
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("in_band_rejections_and_healthy_results_do_not_trip_or_reset_wrongly", async () => {
    const { inner, guard } = setup();
    vi.spyOn(inner, "submitPrepared").mockResolvedValue({
      ok: false,
      reason: "rejected",
    });
    for (let i = 0; i < 5; i += 1) {
      await guard.rail.submitPrepared({ kind: "funding" } as never);
    }
    expect(guard.state().algod.open).toBe(false);
  });

  it("errors_tagged_with_a_dependency_open_that_dependency_not_the_method_default", async () => {
    const { inner, guard } = setup();
    vi.spyOn(inner, "getTransactionStatus").mockImplementation(async () => {
      throw new RailError("UNAVAILABLE", "Chain query unavailable", "indexer");
    });
    for (let i = 0; i < 3; i += 1) {
      await guard.rail.getTransactionStatus("tx").catch(() => {});
    }
    expect(guard.state().indexer.open).toBe(true);
    expect(guard.state().algod.open).toBe(false);
    await expect(guard.rail.getBalances("A")).resolves.toBeTruthy();
  });
});
