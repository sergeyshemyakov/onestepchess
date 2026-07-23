import { afterEach, describe, expect, it } from "vitest";
import { findMoveContextFen, writeMoveContext } from "./storage.js";

afterEach(() => {
  localStorage.clear();
});

describe("move contexts (playtest UI fixes — active loop over claim position)", () => {
  it("stores contexts capped at 20 and finds the nearest by movedAt", () => {
    for (let i = 0; i < 25; i += 1) {
      writeMoveContext({
        uci: "e2e4",
        san: "e4",
        side: "white",
        demo: false,
        fen: `fen-${i}`,
        at: new Date(1_000 * i).toISOString(),
      });
    }
    const raw: unknown[] = JSON.parse(
      localStorage.getItem("osc.moveContexts") ?? "[]",
    );
    expect(raw.length).toBe(20);
    expect(
      findMoveContextFen({
        uci: "e2e4",
        side: "white",
        demo: false,
        movedAt: new Date(1_000 * 24 + 100).toISOString(),
      }),
    ).toBe("fen-24");
    expect(
      findMoveContextFen({
        uci: "a2a3",
        side: "white",
        demo: false,
        movedAt: new Date(0).toISOString(),
      }),
    ).toBeNull();
  });

  it("never matches across the demo/staked boundary", () => {
    writeMoveContext({
      uci: "e2e4",
      san: "e4",
      side: "white",
      demo: true,
      fen: "demo-fen",
      at: new Date(0).toISOString(),
    });
    expect(
      findMoveContextFen({
        uci: "e2e4",
        side: "white",
        demo: false,
        movedAt: new Date(0).toISOString(),
      }),
    ).toBeNull();
  });

  it("treats corrupt stored JSON as empty", () => {
    localStorage.setItem("osc.moveContexts", "{nope");
    expect(
      findMoveContextFen({
        uci: "e2e4",
        side: "white",
        demo: false,
        movedAt: new Date(0).toISOString(),
      }),
    ).toBeNull();
  });
});
