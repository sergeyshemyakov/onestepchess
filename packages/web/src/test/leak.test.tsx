import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoGameIdentity, GameIdentityLeak } from "./leak.js";

afterEach(cleanup);

describe("I7 leak-test helper self-test (#27)", () => {
  it("fails on a seeded game-identity string in the rendered DOM", () => {
    const view = render(<div>finished: gentle-rook-042</div>);
    expect(() =>
      assertNoGameIdentity(view.container, ["gentle-rook-042", "gm_123"]),
    ).toThrow(GameIdentityLeak);
  });

  it("catches identity hidden in attributes, not just text", () => {
    const view = render(<div data-game="gm_123" />);
    expect(() => assertNoGameIdentity(view.container, ["gm_123"])).toThrow(
      GameIdentityLeak,
    );
  });

  it("passes on a clean surface", () => {
    const view = render(<div>board reserved · T−04:12</div>);
    expect(() =>
      assertNoGameIdentity(view.container, ["gentle-rook-042", "gm_123"]),
    ).not.toThrow();
  });
});
