import type { GameRules } from "../config.js";
import type {
  ClaimStatus,
  EpochMs,
  GameStatus,
  IntentStatus,
  PayoutStatus,
  Phase,
} from "../types.js";

export type FsmEntity = "game" | "claim" | "intent" | "payout";

export const FSM = {
  game: {
    active: ["endspiel", "finished", "aborted"],
    endspiel: ["finished", "aborted"],
    finished: [],
    aborted: [],
  },
  claim: {
    open: ["moved", "expired"],
    moved: [],
    expired: [],
  },
  intent: {
    verified: ["settling", "failed"],
    settling: ["settled", "failed"],
    settled: [],
    failed: [],
  },
  payout: {
    pending: ["prepared", "failed"],
    prepared: ["submitted", "pending", "failed"],
    submitted: ["confirmed", "failed", "pending"],
    confirmed: [],
    failed: ["pending"],
  },
} as const satisfies {
  readonly game: Readonly<Record<GameStatus, readonly GameStatus[]>>;
  readonly claim: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>>;
  readonly intent: Readonly<Record<IntentStatus, readonly IntentStatus[]>>;
  readonly payout: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>>;
};

export function canTransition(
  entity: FsmEntity,
  from: string,
  to: string,
): boolean {
  const table = FSM[entity] as Readonly<Record<string, readonly string[]>>;
  return table[from]?.includes(to) ?? false;
}

export function claimExpiryDue(
  claim: { readonly status: ClaimStatus; readonly deadline: EpochMs },
  hasInFlightIntent: boolean,
  now: EpochMs,
): boolean {
  return claim.status === "open" && !hasInFlightIntent && now >= claim.deadline;
}

export function gameStallDue(
  game: { readonly status: GameStatus; readonly lastPlyAt: EpochMs },
  now: EpochMs,
  config: GameRules,
): boolean {
  if (game.status === "finished" || game.status === "aborted") {
    return false;
  }
  return now - game.lastPlyAt >= config.STALL_ABORT_HOURS * 60 * 60 * 1_000;
}

export function nextClaimDelaySeconds(phase: Phase, config: GameRules): number {
  return phase === "endspiel" ? 0 : config.MIN_PLY_INTERVAL_SECONDS;
}
