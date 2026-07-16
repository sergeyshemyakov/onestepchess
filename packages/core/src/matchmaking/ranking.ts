import type { Rng } from "../rng.js";
import type { EpochMs, PlayerKind } from "../types.js";
import {
  type CandidateGame,
  eligibleGames,
  type Participation,
} from "./eligibility.js";

export function pickGame(args: {
  eligible: readonly CandidateGame[];
  requesterKind: PlayerKind;
  now: EpochMs;
  rng: Rng;
}): CandidateGame | null {
  const { eligible, requesterKind, rng } = args;
  if (eligible.length === 0) {
    return null;
  }
  // R1: endspiel urgency must not lose the die roll — agents pick among
  // endspiel games only whenever one is eligible.
  const endspiel = eligible.filter((game) => game.status === "endspiel");
  const stratum =
    requesterKind === "agent" && endspiel.length > 0 ? endspiel : eligible;
  const byStaleness = [...stratum].sort(
    (left, right) => left.lastPlyAt - right.lastPlyAt,
  );
  const poolSize = byStaleness.length < 3 ? byStaleness.length : 3;
  // Truncation equals floor here: rng() is in [0, 1), so the product is a
  // nonnegative number below 3.
  const index = (rng() * poolSize) | 0;
  return byStaleness[index] ?? null;
}

export function selectGame(args: {
  games: readonly CandidateGame[];
  requesterKind: PlayerKind;
  participation: readonly Participation[];
  now: EpochMs;
  rng: Rng;
}): CandidateGame | null {
  return pickGame({
    eligible: eligibleGames(args),
    requesterKind: args.requesterKind,
    now: args.now,
    rng: args.rng,
  });
}
