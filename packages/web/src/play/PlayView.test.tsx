import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimFixture, metaFixture } from "../test/fixtures.jsx";
import type { PlayState } from "./machine.js";
import { PlayView } from "./PlayView.jsx";
import type { PlayFlow } from "./usePlayFlow.js";

afterEach(cleanup);

function flowWith(state: PlayState): PlayFlow {
  return {
    state,
    send: vi.fn(),
    checkExpiry: vi.fn(),
  } as unknown as PlayFlow;
}

describe("check & en passant surfacing (playtest round 1)", () => {
  it("highlights the checked king and announces CHECK", () => {
    // Black rook on e2 checks the white king on e1.
    const claim = claimFixture({
      fen: "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
      legalMoves: [{ uci: "e1e2", san: "Kxe2" }],
    });
    const view = render(
      <PlayView
        flow={flowWith({ phase: "FOCUS", demo: false, claim, selected: null })}
        meta={metaFixture}
      />,
    );
    expect(
      view.container
        .querySelector('[data-square="e1"]')
        ?.classList.contains("chk"),
    ).toBe(true);
    expect(view.container.textContent).toContain("CHECK");
  });

  it("marks the en passant victim and hints in the console", () => {
    const claim = claimFixture({
      fen: "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3",
      legalMoves: [
        { uci: "e5d6", san: "exd6" },
        { uci: "e5e6", san: "e6" },
      ],
    });
    const view = render(
      <PlayView
        flow={flowWith({ phase: "FOCUS", demo: false, claim, selected: null })}
        meta={metaFixture}
      />,
    );
    expect(
      view.container
        .querySelector('[data-square="d5"]')
        ?.classList.contains("ep"),
    ).toBe(true);
    expect(view.container.textContent).toContain("en passant");
    expect(view.container.querySelector(".sq.chk")).toBeNull();
  });

  it("shows neither marker in an ordinary position", () => {
    const view = render(
      <PlayView
        flow={flowWith({
          phase: "FOCUS",
          demo: false,
          claim: claimFixture(),
          selected: null,
        })}
        meta={metaFixture}
      />,
    );
    expect(view.container.querySelector(".sq.chk")).toBeNull();
    expect(view.container.querySelector(".sq.ep")).toBeNull();
    expect(view.container.textContent).not.toContain("CHECK");
    expect(view.container.textContent).not.toContain("en passant");
  });
});
