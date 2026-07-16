import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STARTING_FEN } from "../types.js";
import {
  type CandidateGame,
  eligibleGames,
  type Participation,
} from "./eligibility.js";

const BLACK_TO_MOVE_FEN =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

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

function args(overrides: {
  games?: readonly CandidateGame[];
  requesterKind?: "human" | "agent" | "guest";
  participation?: readonly Participation[];
  now?: number;
}) {
  return {
    games: overrides.games ?? [game()],
    requesterKind: overrides.requesterKind ?? "human",
    participation: overrides.participation ?? [],
    now: overrides.now ?? NOW,
  };
}

const candidateArb: fc.Arbitrary<CandidateGame> = fc.record({
  id: fc.integer({ min: 0, max: 30 }).map((n) => `g${n}`),
  status: fc.constantFrom("active" as const, "endspiel" as const),
  fen: fc.constantFrom(STARTING_FEN, BLACK_TO_MOVE_FEN),
  ply: fc.integer({ min: 0, max: 200 }),
  minNextClaimAt: fc.integer({ min: NOW - 120_000, max: NOW + 120_000 }),
  lastPlyAt: fc.integer({ min: NOW - 3_600_000, max: NOW }),
  hasOpenClaim: fc.boolean(),
  cooldownPlies: fc.integer({ min: 0, max: 8 }),
});

const participationArb: fc.Arbitrary<Participation> = fc.record({
  gameId: fc.integer({ min: 0, max: 30 }).map((n) => `g${n}`),
  side: fc.constantFrom("white" as const, "black" as const),
  lastPly: fc.integer({ min: 0, max: 200 }),
});

describe("eligibleGames", () => {
  it("E1: an active game is eligible for every requester kind", () => {
    for (const kind of ["human", "agent", "guest"] as const) {
      expect(
        eligibleGames(args({ requesterKind: kind })).map((g) => g.id),
      ).toEqual(["g1"]);
    }
  });

  it("E1: an endspiel game is eligible only for agents", () => {
    const games = [game({ status: "endspiel" })];
    expect(eligibleGames(args({ games, requesterKind: "agent" }))).toHaveLength(
      1,
    );
    expect(eligibleGames(args({ games, requesterKind: "human" }))).toEqual([]);
    expect(eligibleGames(args({ games, requesterKind: "guest" }))).toEqual([]);
  });

  it("E2: a game with an open claim is not eligible", () => {
    expect(
      eligibleGames(args({ games: [game({ hasOpenClaim: true })] })),
    ).toEqual([]);
  });

  it("E3: a game with now exactly at minNextClaimAt is eligible", () => {
    expect(
      eligibleGames(args({ games: [game({ minNextClaimAt: NOW })] })),
    ).toHaveLength(1);
  });

  it("E3: a game one millisecond before minNextClaimAt is not eligible", () => {
    expect(
      eligibleGames(args({ games: [game({ minNextClaimAt: NOW + 1 })] })),
    ).toEqual([]);
  });

  it("E4: a participant is only offered the side they already played", () => {
    const whiteToMove = [game()];
    const participation: Participation[] = [
      { gameId: "g1", side: "black", lastPly: 0 },
    ];
    expect(eligibleGames(args({ games: whiteToMove, participation }))).toEqual(
      [],
    );
    expect(
      eligibleGames(
        args({
          games: whiteToMove,
          participation: [{ gameId: "g1", side: "white", lastPly: 0 }],
        }),
      ),
    ).toHaveLength(1);
  });

  it("E5: cooldown equality is eligible, one below is not", () => {
    const games = [game({ ply: 10, cooldownPlies: 6 })];
    const atBoundary: Participation[] = [
      { gameId: "g1", side: "white", lastPly: 4 },
    ];
    const oneBelow: Participation[] = [
      { gameId: "g1", side: "white", lastPly: 5 },
    ];
    expect(
      eligibleGames(args({ games, participation: atBoundary })),
    ).toHaveLength(1);
    expect(eligibleGames(args({ games, participation: oneBelow }))).toEqual([]);
  });

  it("E5: the cooldown uses the game's own cooldownPlies snapshot", () => {
    const games = [game({ ply: 10, cooldownPlies: 2 })];
    const participation: Participation[] = [
      { gameId: "g1", side: "white", lastPly: 8 },
    ];
    expect(eligibleGames(args({ games, participation }))).toHaveLength(1);
  });

  it("guests filter exactly as humans on identical inputs", () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb, { maxLength: 12 }),
        fc.array(participationArb, { maxLength: 12 }),
        (games, participation) => {
          expect(
            eligibleGames({
              games,
              requesterKind: "guest",
              participation,
              now: NOW,
            }),
          ).toEqual(
            eligibleGames({
              games,
              requesterKind: "human",
              participation,
              now: NOW,
            }),
          );
        },
      ),
    );
  });

  it("a human is never offered an endspiel game on any input", () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb, { maxLength: 12 }),
        fc.array(participationArb, { maxLength: 12 }),
        (games, participation) => {
          const eligible = eligibleGames({
            games,
            requesterKind: "human",
            participation,
            now: NOW,
          });
          expect(eligible.every((g) => g.status === "active")).toBe(true);
        },
      ),
    );
  });

  it("never returns a terminal game", () => {
    const terminalish = [
      game({ id: "g1", status: "finished" as unknown as "active" }),
      game({ id: "g2", status: "aborted" as unknown as "active" }),
      game({ id: "g3" }),
    ];
    expect(
      eligibleGames(args({ games: terminalish })).map((g) => g.id),
    ).toEqual(["g3"]);
  });

  it("is idempotent and order-preserving", () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb, { maxLength: 12 }),
        fc.array(participationArb, { maxLength: 12 }),
        (games, participation) => {
          const once = eligibleGames({
            games,
            requesterKind: "agent",
            participation,
            now: NOW,
          });
          const twice = eligibleGames({
            games: once,
            requesterKind: "agent",
            participation,
            now: NOW,
          });
          expect(twice).toEqual(once);
          const inputOrder = games.filter((g) => once.includes(g));
          expect(once).toEqual(inputOrder);
        },
      ),
    );
  });
});
