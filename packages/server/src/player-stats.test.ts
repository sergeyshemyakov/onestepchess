import { describe, expect, it } from "vitest";
import { winratePct } from "./player-stats.js";

describe("player stats", () => {
  it("winrate_excludes_draws_by_using_only_decisive_game_counts", () => {
    expect(winratePct(3, 1)).toBe(75);
    expect(winratePct(0, 0)).toBeNull();
  });
});
