import { describe, expect, it } from "vitest";
import { nonOverlapping } from "./non-overlapping.js";

describe("nonOverlapping", () => {
  it("skips invocations while a previous pass is still in flight", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guarded = nonOverlapping(async () => {
      calls += 1;
      await gate;
    });

    const first = guarded();
    const second = guarded();
    await second;
    expect(calls).toBe(1);
    release();
    await first;

    await guarded();
    expect(calls).toBe(2);
  });

  it("allows the next pass after a rejected one settles", async () => {
    let calls = 0;
    const guarded = nonOverlapping(async () => {
      calls += 1;
      throw new Error("pass failed");
    });

    await expect(guarded()).rejects.toThrow("pass failed");
    await expect(guarded()).rejects.toThrow("pass failed");
    expect(calls).toBe(2);
  });
});
