import type { ClaimDraft } from "../lib/storage.js";
import { writeClaimDraft } from "../lib/storage.js";
import type { PlayState } from "./machine.js";

const DRAFT_PHASES = new Set(["FOCUS", "CONFIRM", "SIGNING", "SETTLING"]);

/** The draft a state implies: written on entering FOCUS, updated on the move
 * choice, cleared in terminal states. The signed payment header is memory
 * only and never appears here (§5.5). */
export function draftFor(
  state: PlayState,
  savedAt: () => string = () => new Date().toISOString(),
): ClaimDraft | null {
  if (!DRAFT_PHASES.has(state.phase) || state.claim === undefined) return null;
  return {
    claimId: state.claim.claimId,
    ...(state.chosenMove === undefined
      ? {}
      : { moveUci: state.chosenMove.uci }),
    savedAt: savedAt(),
  };
}

/** Sync sessionStorage to the state's implied draft; writes only when the
 * meaningful fields change (savedAt alone never forces a write). */
export function syncDraft(
  previous: PlayState,
  next: PlayState,
  write: (draft: ClaimDraft | null) => void = writeClaimDraft,
  savedAt?: () => string,
): void {
  const before = draftFor(previous, () => "");
  const after = draftFor(next, () => "");
  if (
    before?.claimId === after?.claimId &&
    before?.moveUci === after?.moveUci
  ) {
    return;
  }
  write(after === null ? null : draftFor(next, savedAt));
}
