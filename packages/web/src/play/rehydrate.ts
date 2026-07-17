import type { ApiClient } from "../api/client.js";
import type { ClaimStatus, ClaimView } from "../api/schemas.js";
import type { ClaimDraft } from "../lib/storage.js";
import type { PlayState } from "./machine.js";

export type RehydrationInput = {
  /** `GET /claims/current`: 200 → the claim, 404 → null. */
  readonly current: ClaimView | null;
  readonly draft: ClaimDraft | null;
  /** `GET /claims/:id/status` for the draft claim — fetched only on the
   * current-404 recovery path. */
  readonly status?: ClaimStatus | null;
};

/** §5.5 decision table, pure. A lost memory-only payment header is never
 * reconstructed — ambiguous outcomes land in SETTLING with poll-only. */
export function decideRehydration(input: RehydrationInput): PlayState {
  const { current, draft } = input;
  if (current !== null) {
    const restored =
      draft !== null &&
      draft.claimId === current.claimId &&
      draft.moveUci !== undefined
        ? current.legalMoves.find((move) => move.uci === draft.moveUci)
        : undefined;
    if (restored !== undefined) {
      return {
        phase: "CONFIRM",
        demo: current.demo,
        claim: current,
        chosenMove: restored,
        selected: null,
      };
    }
    return {
      phase: "FOCUS",
      demo: current.demo,
      claim: current,
      selected: null,
    };
  }
  if (draft === null) return { phase: "IDLE", demo: false };
  const status = input.status ?? null;
  if (status === null) return { phase: "IDLE", demo: false };
  switch (status.status) {
    case "moved":
      // The durable receipt — a reload mid-settle relies on the server's
      // intent FSM, not on resending anything from storage.
      return {
        phase: "RECEIPT",
        demo: status.receipt.debitMicroUsdc === 0,
        receipt: status.receipt,
      };
    case "expired":
      return { phase: "EXPIRED", demo: false };
    case "open": {
      const claim = status.claim;
      if (status.paymentState !== null) {
        return {
          phase: "SETTLING",
          demo: claim.demo,
          claim,
          settlePoll: true,
          ...(draft.moveUci === undefined
            ? {}
            : {
                chosenMove: claim.legalMoves.find(
                  (move) => move.uci === draft.moveUci,
                ),
              }),
        };
      }
      const restored =
        draft.moveUci === undefined
          ? undefined
          : claim.legalMoves.find((move) => move.uci === draft.moveUci);
      if (restored !== undefined) {
        return {
          phase: "CONFIRM",
          demo: claim.demo,
          claim,
          chosenMove: restored,
          selected: null,
        };
      }
      return { phase: "FOCUS", demo: claim.demo, claim, selected: null };
    }
  }
}

/** Effectful runner: FOCUS/CONFIRM restore (board + chosen move + deadline)
 * costs one `GET /claims/current`; the status endpoint is consulted only on
 * the 404-with-draft recovery path (moved/expired/settling discovery). */
export async function rehydrate(
  client: Pick<ApiClient, "getCurrentClaim" | "getClaimStatus">,
  draft: ClaimDraft | null,
): Promise<PlayState> {
  const current = await client.getCurrentClaim();
  if (current !== null || draft === null) {
    return decideRehydration({ current, draft });
  }
  const status = await client.getClaimStatus(draft.claimId);
  return decideRehydration({ current, draft, status });
}
