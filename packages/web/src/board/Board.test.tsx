import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board, boardPxForViewport, squareRenderProbe } from "./Board.jsx";
import {
  movesTo,
  needsPromotion,
  selectableSquares,
  targetsFor,
} from "./moves.js";

afterEach(() => {
  cleanup();
  squareRenderProbe.onRender = null;
});

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

describe("board diff rendering (§8.2)", () => {
  it("re-renders only changed squares between two FENs", () => {
    const rendered: string[] = [];
    const view = render(<Board fen={START} />);
    squareRenderProbe.onRender = (square) => rendered.push(square);
    view.rerender(<Board fen={AFTER_E4} />);
    expect(new Set(rendered)).toEqual(new Set(["e2", "e4"]));
  });

  it("renders all 64 squares with pieces from the FEN", () => {
    const view = render(<Board fen={START} />);
    expect(view.container.querySelectorAll(".sq")).toHaveLength(64);
    expect(view.container.querySelectorAll("svg.pc")).toHaveLength(32);
  });
});

describe("board interaction (§8.2)", () => {
  it("highlights exactly the passed legalTargets and fires onSquareTap", () => {
    const onTap = vi.fn();
    const view = render(
      <Board
        fen={START}
        interactive
        selected="e2"
        legalTargets={["e3", "e4"]}
        onSquareTap={onTap}
      />,
    );
    const dotted = [...view.container.querySelectorAll(".sq")].filter(
      (sq) => sq.querySelector(".dot") !== null,
    );
    expect(dotted.map((sq) => sq.getAttribute("data-square")).sort()).toEqual([
      "e3",
      "e4",
    ]);
    expect(
      view.container
        .querySelector('[data-square="e2"]')
        ?.classList.contains("sel"),
    ).toBe(true);
    const target = view.container.querySelector('[data-square="e4"]');
    if (target === null) throw new Error("square missing");
    fireEvent.click(target);
    expect(onTap).toHaveBeenCalledWith("e4");
  });

  it("is inert when not interactive", () => {
    const onTap = vi.fn();
    const view = render(<Board fen={START} onSquareTap={onTap} />);
    expect(view.container.querySelectorAll("button.sq")).toHaveLength(0);
    const square = view.container.querySelector('[data-square="e2"]');
    if (square === null) throw new Error("square missing");
    fireEvent.click(square);
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe("promotion routing (§8.2)", () => {
  const legal = [
    { uci: "e7e8q", san: "e8=Q" },
    { uci: "e7e8r", san: "e8=R" },
    { uci: "e7e8b", san: "e8=B" },
    { uci: "e7e8n", san: "e8=N" },
    { uci: "a2a3", san: "a3" },
  ];

  it("routes a promotion UCI set through the picker", () => {
    const promotionMoves = movesTo(legal, "e7", "e8");
    expect(promotionMoves).toHaveLength(4);
    expect(needsPromotion(promotionMoves)).toBe(true);
    expect(needsPromotion(movesTo(legal, "a2", "a3"))).toBe(false);
  });

  it("derives selectable squares and targets from legalMoves only", () => {
    expect([...selectableSquares(legal)].sort()).toEqual(["a2", "e7"]);
    expect(targetsFor(legal, "e7")).toEqual(["e8"]);
  });
});

describe("touch targets (D13)", () => {
  it("keeps squares ≥ 44px at the 420px breakpoint and the board ≥ 320px", () => {
    expect(boardPxForViewport(420) / 8).toBeGreaterThanOrEqual(44);
    expect(boardPxForViewport(300)).toBeGreaterThanOrEqual(320);
    expect(boardPxForViewport(1440)).toBeLessThanOrEqual(520);
  });
});

describe("move FX (§8.2)", () => {
  it("keeps every fx keyframe transform/opacity-only", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../styles/components.css"),
      "utf8",
    );
    const blocks: string[] = [];
    for (const match of css.matchAll(/@keyframes fx\w+ \{/g)) {
      let depth = 1;
      let end = (match.index ?? 0) + match[0].length;
      while (depth > 0 && end < css.length) {
        if (css[end] === "{") depth += 1;
        if (css[end] === "}") depth -= 1;
        end += 1;
      }
      blocks.push(css.slice(match.index, end));
    }
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const body of blocks) {
      const declarations = [...body.matchAll(/([a-z-]+)\s*:/g)].map(
        (m) => m[1],
      );
      expect(declarations.length).toBeGreaterThan(0);
      for (const property of declarations) {
        expect(["transform", "opacity"]).toContain(property);
      }
    }
  });

  it("plays trail clones on a new fx seq and cleans them up", () => {
    vi.useFakeTimers();
    try {
      const view = render(<Board fen={AFTER_E4} />);
      view.rerender(
        <Board
          fen={AFTER_E4}
          fx={{ kind: "trail", from: "e2", to: "e4", seq: 1 }}
        />,
      );
      const layer = view.container.querySelector(".fxlayer");
      if (layer === null) throw new Error("fx layer missing");
      expect(layer.querySelectorAll(".fx-ghost").length).toBe(5);
      expect(layer.querySelectorAll(".fx-mover").length).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(layer.children.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
