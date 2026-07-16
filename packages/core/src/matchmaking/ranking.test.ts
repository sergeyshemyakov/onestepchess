import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRng } from "../rng.js";
import { STARTING_FEN } from "../types.js";
import type { CandidateGame } from "./eligibility.js";
import { pickGame, selectGame } from "./ranking.js";

const NOW = 1_700_000_000_000;

function game(overrides: Partial<CandidateGame> = {}): CandidateGame {
  return {
    id: "g1",
    status: "active",
    fen: STARTING_FEN,
    ply: 10,
    minNextClaimAt: NOW - 1_000,
    lastPlyAt: NOW - 60_000,
    hasOpenClaim: false,
    cooldownPlies: 6,
    ...overrides,
  };
}

const candidateArb: fc.Arbitrary<CandidateGame> = fc.record({
  id: fc.integer({ min: 0, max: 30 }).map((n) => `g${n}`),
  status: fc.constantFrom("active" as const, "endspiel" as const),
  fen: fc.constant(STARTING_FEN),
  ply: fc.integer({ min: 0, max: 200 }),
  minNextClaimAt: fc.integer({ min: NOW - 120_000, max: NOW + 120_000 }),
  lastPlyAt: fc.integer({ min: NOW - 3_600_000, max: NOW }),
  hasOpenClaim: fc.boolean(),
  cooldownPlies: fc.integer({ min: 0, max: 8 }),
});

describe("pickGame", () => {
  it("returns null iff there is nothing eligible", () => {
    expect(
      pickGame({
        eligible: [],
        requesterKind: "human",
        now: NOW,
        rng: createRng(1),
      }),
    ).toBeNull();
  });

  it("R1: an agent's pick is always the endspiel game even among staler active games", () => {
    const endspiel = game({
      id: "endspiel",
      status: "endspiel",
      lastPlyAt: NOW,
    });
    const staler = Array.from({ length: 9 }, (_, i) =>
      game({ id: `active${i}`, lastPlyAt: NOW - (i + 1) * 100_000 }),
    );
    const rng = createRng(7);
    for (let i = 0; i < 200; i += 1) {
      const pick = pickGame({
        eligible: [...staler, endspiel],
        requesterKind: "agent",
        now: NOW,
        rng,
      });
      expect(pick?.id).toBe("endspiel");
    }
  });

  it("R2: orders by staleness descending with a stable sort", () => {
    const eligible = [
      game({ id: "fresh", lastPlyAt: NOW - 1_000 }),
      game({ id: "tied-first", lastPlyAt: NOW - 50_000 }),
      game({ id: "tied-second", lastPlyAt: NOW - 50_000 }),
      game({ id: "stalest", lastPlyAt: NOW - 90_000 }),
    ];
    const pickAt = (roll: number) =>
      pickGame({ eligible, requesterKind: "human", now: NOW, rng: () => roll })
        ?.id;
    expect(pickAt(0)).toBe("stalest");
    expect(pickAt(0.4)).toBe("tied-first");
    expect(pickAt(0.7)).toBe("tied-second");
  });

  it("R3: picks uniformly among the top min(3, n)", () => {
    const only = [game({ id: "solo" })];
    expect(
      pickGame({
        eligible: only,
        requesterKind: "human",
        now: NOW,
        rng: () => 0.99,
      })?.id,
    ).toBe("solo");
  });

  it("same inputs and same seed produce the same pick", () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb, { minLength: 1, maxLength: 12 }),
        fc.integer(),
        (eligible, seed) => {
          const first = pickGame({
            eligible,
            requesterKind: "agent",
            now: NOW,
            rng: createRng(seed),
          });
          const second = pickGame({
            eligible,
            requesterKind: "agent",
            now: NOW,
            rng: createRng(seed),
          });
          expect(second).toEqual(first);
        },
      ),
    );
  });

  it("draws every top-3 candidate at least once over 10^4 picks", () => {
    const eligible = [
      game({ id: "a", lastPlyAt: NOW - 400_000 }),
      game({ id: "b", lastPlyAt: NOW - 300_000 }),
      game({ id: "c", lastPlyAt: NOW - 200_000 }),
      game({ id: "d", lastPlyAt: NOW - 100_000 }),
    ];
    const rng = createRng(2024);
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      const pick = pickGame({
        eligible,
        requesterKind: "human",
        now: NOW,
        rng,
      });
      if (pick !== null) {
        seen.add(pick.id);
      }
    }
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("selectGame", () => {
  it("always picks from eligibleGames output", () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb, { maxLength: 12 }),
        fc.integer(),
        fc.constantFrom("human" as const, "agent" as const, "guest" as const),
        (games, seed, requesterKind) => {
          const pick = selectGame({
            games,
            requesterKind,
            participation: [],
            now: NOW,
            rng: createRng(seed),
          });
          if (pick === null) {
            return;
          }
          expect(games).toContain(pick);
          if (requesterKind !== "agent") {
            expect(pick.status).toBe("active");
          }
          expect(pick.hasOpenClaim).toBe(false);
          expect(pick.minNextClaimAt).toBeLessThanOrEqual(NOW);
        },
      ),
    );
  });
});
