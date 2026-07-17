import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIMER_URGENT_SECONDS, Timer, timerPhase } from "./Timer.jsx";

afterEach(cleanup);

const REVEAL = 120;

function renderAt(leftSeconds: number, reduced = false) {
  const base = 1_000_000_000;
  const deadline = new Date(base + leftSeconds * 1_000).toISOString();
  const original = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) =>
    ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof globalThis.matchMedia;
  const view = render(
    <Timer
      deadline={deadline}
      revealSeconds={REVEAL}
      totalSeconds={600}
      now={() => base}
    />,
  );
  globalThis.matchMedia = original;
  return view;
}

describe("timer threshold states vs a fake clock (§4.6)", () => {
  it("encodes the D9 thresholds", () => {
    expect(timerPhase(600, REVEAL)).toBe("quiet");
    expect(timerPhase(REVEAL, REVEAL)).toBe("warn");
    expect(timerPhase(TIMER_URGENT_SECONDS, REVEAL)).toBe("crit");
    expect(timerPhase(0, REVEAL)).toBe("expired");
  });

  it("renders the quiet draining bar with no digits above reveal", () => {
    const view = renderAt(600);
    const timer = view.container.querySelector(".timer");
    expect(timer?.getAttribute("data-phase")).toBe("quiet");
    expect(timer?.textContent).toContain("board reserved");
    expect(timer?.textContent).not.toMatch(/\d:\d\d/);
    expect(timer?.querySelector(".bar i")).not.toBeNull();
  });

  it("turns numeric at the reveal threshold", () => {
    const view = renderAt(115);
    const timer = view.container.querySelector(".timer");
    expect(timer?.getAttribute("data-phase")).toBe("warn");
    expect(timer?.classList.contains("warn")).toBe(true);
    expect(timer?.textContent).toBe("T-01:55");
  });

  it("goes inverse blink at the urgent threshold", () => {
    const view = renderAt(24);
    const timer = view.container.querySelector(".timer");
    expect(timer?.getAttribute("data-phase")).toBe("crit");
    expect(timer?.classList.contains("crit")).toBe(true);
    expect(timer?.classList.contains("rm")).toBe(false);
  });

  it("swaps blink for solid inverse under prefers-reduced-motion", () => {
    const view = renderAt(24, true);
    const timer = view.container.querySelector(".timer");
    expect(timer?.classList.contains("crit")).toBe(true);
    expect(timer?.classList.contains("rm")).toBe(true);
  });

  it("fires onExpire once when the deadline passes (cosmetic only)", () => {
    vi.useFakeTimers();
    try {
      const base = 1_000_000_000;
      let nowMs = base;
      const onExpire = vi.fn();
      render(
        <Timer
          deadline={new Date(base + 1_000).toISOString()}
          revealSeconds={REVEAL}
          now={() => nowMs}
          onExpire={onExpire}
        />,
      );
      nowMs = base + 2_000;
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
