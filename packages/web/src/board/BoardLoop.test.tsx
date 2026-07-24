import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BoardLoop } from "./BoardLoop.jsx";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("board_loop_types_the_mover_then_teleports_it_back_over_the_full_position", () => {
  vi.useFakeTimers();
  render(<BoardLoop fen={START_FEN} from="e2" to="e4" san="e4" side="white" />);

  const loop = screen.getByTestId("board-loop");
  const mover = loop.querySelector(".boardloop-piece") as HTMLElement;
  const source = "translate(400%, 600%)";
  const target = "translate(400%, 400%)";

  expect(loop.querySelectorAll("svg.pc")).toHaveLength(32);
  expect(mover.style.transform).toBe(source);
  expect(loop.querySelector('[data-square="d2"] svg.pc')).not.toBeNull();

  act(() => vi.advanceTimersByTime(900));
  expect(mover.classList.contains("erasing")).toBe(true);
  expect(mover.style.transform).toBe(source);
  expect(loop.querySelector(".boardloop-sweep")).not.toBeNull();

  act(() => vi.advanceTimersByTime(200));
  expect(mover.classList.contains("typing")).toBe(true);
  expect(mover.style.transform).toBe(target);
  expect(loop.querySelector(".boardloop-caret")).not.toBeNull();
  expect(loop.querySelector('[data-square="d2"] svg.pc')).not.toBeNull();

  act(() => vi.advanceTimersByTime(1_480));
  expect(mover.classList.contains("erasing")).toBe(false);
  expect(mover.classList.contains("typing")).toBe(false);
  expect(mover.style.transform).toBe(source);

  act(() => vi.advanceTimersByTime(900));
  expect(mover.classList.contains("erasing")).toBe(true);
});
