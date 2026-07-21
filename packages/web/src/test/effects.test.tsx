import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Board } from "../board/Board.jsx";
import { Timer } from "../play/Timer.jsx";
import { Replayer } from "../replay/Replayer.jsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("web_effects_idle_and_cleanup_without_orphaned_work", () => {
  vi.useFakeTimers();
  const disconnect = vi.fn();
  let visibility: IntersectionObserverCallback = () => undefined;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      visibility = callback;
    }
    observe = vi.fn();
    disconnect = disconnect;
    unobserve = vi.fn();
    takeRecords = () => [];
    root = null;
    rootMargin = "0px";
    thresholds = [0];
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  const onPly = vi.fn();
  const view = render(
    <>
      <Replayer
        autoPlay
        loop
        onPly={onPly}
        plies={[
          {
            fenAfter:
              "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          },
        ]}
      />
      <Timer
        deadline={new Date(Date.now() + 10_000).toISOString()}
        revealSeconds={120}
      />
      <Board
        fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        fx={{ kind: "trail", from: "e2", to: "e4", seq: 1 }}
      />
    </>,
  );

  act(() => vi.advanceTimersByTime(500));
  expect(onPly).toHaveBeenCalled();
  const callsOnScreen = onPly.mock.calls.length;
  act(() =>
    visibility(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  act(() => vi.advanceTimersByTime(1_500));
  expect(onPly).toHaveBeenCalledTimes(callsOnScreen);

  view.unmount();
  expect(disconnect).toHaveBeenCalled();
  expect(document.querySelectorAll(".fxpc")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
