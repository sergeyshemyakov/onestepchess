import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatElapsedTime,
  formatGameDuration,
  formatLocalTime,
  formatMicroUsdc,
  nextAtLabel,
  secondsUntil,
} from "./format.js";

describe("formatMicroUsdc (§4.5 cases)", () => {
  it("renders one cent and above in dollar form", () => {
    expect(formatMicroUsdc(10_000)).toBe("$0.01");
    expect(formatMicroUsdc(20_000)).toBe("$0.02");
    expect(formatMicroUsdc(1_000_000)).toBe("$1.00");
    expect(formatMicroUsdc(15_000)).toBe("$0.015");
  });

  it("renders below one cent in cent form", () => {
    expect(formatMicroUsdc(1_000)).toBe("0.1 ¢");
    expect(formatMicroUsdc(200)).toBe("0.02 ¢");
    expect(formatMicroUsdc(0)).toBe("0 ¢");
    expect(formatMicroUsdc(9_999)).toBe("0.9999 ¢");
  });
});

describe("time rendering (§4.5)", () => {
  it("renders same-day timestamps as HH:MM local", () => {
    const now = new Date(2026, 6, 17, 13, 0, 0);
    const sameDay = new Date(2026, 6, 17, 14, 5, 0);
    expect(formatLocalTime(sameDay.toISOString(), now)).toBe("14:05");
  });

  it("renders other days as date + time", () => {
    const now = new Date(2026, 6, 17, 13, 0, 0);
    const other = new Date(2026, 6, 18, 9, 30, 0);
    expect(formatLocalTime(other.toISOString(), now)).toBe("2026-07-18 09:30");
  });

  it("derives next-at labels from Retry-After against the local clock", () => {
    const now = new Date(2026, 6, 17, 13, 58, 0);
    expect(nextAtLabel(120, now)).toBe("14:00");
  });

  it("formats countdowns and clamps negatives to zero", () => {
    expect(formatCountdown(252)).toBe("04:12");
    expect(formatCountdown(-3)).toBe("00:00");
    const deadline = new Date(1_000_000).toISOString();
    expect(secondsUntil(deadline, 990_000)).toBe(10);
    expect(secondsUntil(deadline, 2_000_000)).toBe(0);
  });

  it("formats aggregate thinking time and the full game time range", () => {
    const started = new Date(2026, 6, 17, 9, 47, 0);
    const finished = new Date(2026, 6, 17, 11, 0, 0);
    expect(formatElapsedTime(131_000)).toBe("2m 11s");
    expect(
      formatGameDuration(started.toISOString(), finished.toISOString()),
    ).toBe("09:47 - 11:00 (1 hr 13 mins)");
  });
});
