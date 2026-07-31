import { nextAtLabel } from "../lib/format.js";
import type { PlayPhase } from "../play/machine.js";

export type CtaState = {
  readonly disabled: boolean;
  readonly reason: string | null;
};

/** Disabled-with-reason matrix for the hub CTAs (F-W3 minimal): open claim,
 * quota out, PAUSED (the banner owns the paused message). */
export function playCtaState(input: {
  readonly phase: PlayPhase;
  readonly paused: boolean;
  readonly quotaRetryAfterSeconds?: number;
  readonly now?: Date;
}): CtaState {
  if (input.paused) {
    return { disabled: true, reason: null };
  }
  const claimOpen =
    input.phase === "FOCUS" ||
    input.phase === "CONFIRM" ||
    input.phase === "SIGNING" ||
    input.phase === "SETTLING";
  if (claimOpen) {
    return { disabled: true, reason: "board is yours — return ▸" };
  }
  if (
    input.phase === "QUOTA_OUT" &&
    input.quotaRetryAfterSeconds !== undefined
  ) {
    return {
      disabled: true,
      reason: `out of boards this hour — next at ${nextAtLabel(input.quotaRetryAfterSeconds, input.now)}`,
    };
  }
  return { disabled: false, reason: null };
}
