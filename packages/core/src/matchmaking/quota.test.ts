import { describe, expect, it } from "vitest";
import { rollingWindowCheck } from "./quota.js";

const NOW = 1_700_000_000_000;
const WINDOW = 3_600;

function check(
  eventTimestamps: readonly number[],
  limit: number,
  windowSeconds = WINDOW,
  now = NOW,
) {
  return rollingWindowCheck({ eventTimestamps, limit, windowSeconds, now });
}

describe("rollingWindowCheck", () => {
  it("allows an empty history with the full limit remaining", () => {
    expect(check([], 12)).toEqual({ ok: true, remaining: 12 });
  });

  it("treats an event exactly windowSeconds old as outside the window", () => {
    const atEdge = NOW - WINDOW * 1_000;
    expect(check([atEdge], 1)).toEqual({ ok: true, remaining: 1 });
    expect(check([atEdge + 1], 1)).toEqual({
      ok: false,
      retryAfterSeconds: expect.any(Number),
    });
  });

  it("counts remaining capacity below the limit", () => {
    expect(check([NOW - 1_000, NOW - 2_000], 12)).toEqual({
      ok: true,
      remaining: 10,
    });
  });

  it("computes retryAfterSeconds exactly against a fake clock", () => {
    const events = [NOW - 3_000_000, NOW - 2_000_000, NOW - 1_000_000];
    expect(check(events, 2)).toEqual({ ok: false, retryAfterSeconds: 1_600 });
  });

  it("rounds retryAfterSeconds up to whole seconds", () => {
    expect(check([NOW - 999], 1, 10)).toEqual({
      ok: false,
      retryAfterSeconds: 10,
    });
  });

  it("handles being over the limit by more than one", () => {
    const events = [NOW - 3_000_000, NOW - 2_000_000, NOW - 1_000_000];
    expect(check(events, 1)).toEqual({ ok: false, retryAfterSeconds: 2_600 });
  });

  it("tolerates unsorted input", () => {
    const sorted = [NOW - 3_000_000, NOW - 2_000_000, NOW - 1_000_000];
    const shuffled = [NOW - 1_000_000, NOW - 3_000_000, NOW - 2_000_000];
    expect(check(shuffled, 2)).toEqual(check(sorted, 2));
  });

  it("ignores out-of-window events when locating the freeing slot", () => {
    const events = [NOW - 2 * WINDOW * 1_000, NOW - 3_000_000, NOW - 1_000_000];
    expect(check(events, 2)).toEqual({ ok: false, retryAfterSeconds: 600 });
  });
});
