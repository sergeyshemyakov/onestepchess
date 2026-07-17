import type {
  ClaimView,
  ErrorEnvelope,
  Move,
  MoveReceipt,
} from "../api/schemas.js";

// §5.5 — the play flow's brain is this pure reducer; effects (API/wallet
// calls) live in the surface hook and come back as events.

export type PlayPhase =
  | "IDLE"
  | "CLAIMING"
  | "FOCUS"
  | "CONFIRM"
  | "SIGNING"
  | "SETTLING"
  | "RECEIPT"
  | "EXPIRED"
  | "NO_BOARDS"
  | "QUOTA_OUT"
  | "PAUSED";

export type PlayState = {
  readonly phase: PlayPhase;
  readonly demo: boolean;
  readonly claim?: ClaimView;
  /** FOCUS sub-state is plain context, not extra FSM states (§5.5). */
  readonly selected?: string | null;
  readonly chosenMove?: Move;
  /** Memory only — never persisted anywhere (§5.5). */
  readonly paymentHeader?: string;
  readonly receipt?: MoveReceipt;
  readonly retryAfterSeconds?: number;
  readonly error?: ErrorEnvelope | null;
  /** True while the settle outcome is ambiguous (202/409) — poll claim
   * status, never re-sign. */
  readonly settlePoll?: boolean;
};

export const initialPlayState: PlayState = { phase: "IDLE", demo: false };

export type PlayEvent =
  | { readonly type: "PLAY"; readonly demo: boolean }
  | { readonly type: "CLAIM_READY"; readonly claim: ClaimView }
  | { readonly type: "NO_BOARDS"; readonly retryAfterSeconds: number }
  | { readonly type: "QUOTA_OUT"; readonly retryAfterSeconds: number }
  | { readonly type: "PAUSED" }
  | { readonly type: "RETRY" }
  | { readonly type: "SELECT"; readonly square: string | null }
  | { readonly type: "MOVE_CHOSEN"; readonly move: Move }
  | { readonly type: "CHANGE_MOVE" }
  | { readonly type: "CONFIRM" }
  | { readonly type: "HEADER_READY"; readonly header: string }
  | { readonly type: "WALLET_REJECTED" }
  | { readonly type: "RECEIPT"; readonly receipt: MoveReceipt }
  | { readonly type: "PAYMENT_PENDING"; readonly retryAfterSeconds: number }
  | { readonly type: "PAYMENT_IN_FLIGHT" }
  | { readonly type: "PAYMENT_FAILED"; readonly envelope: ErrorEnvelope }
  | {
      readonly type: "PAYMENT_UNAVAILABLE";
      readonly retryAfterSeconds: number;
    }
  | { readonly type: "CLAIM_EXPIRED" }
  | { readonly type: "CLAIM_REFRESHED"; readonly claim: ClaimView }
  | { readonly type: "ACK" }
  | { readonly type: "RESTORE"; readonly state: PlayState };

export function playReducer(state: PlayState, event: PlayEvent): PlayState {
  if (event.type === "RESTORE") return event.state;

  switch (state.phase) {
    case "IDLE":
    case "NO_BOARDS":
    case "QUOTA_OUT":
      if (event.type === "PLAY") {
        return { phase: "CLAIMING", demo: event.demo };
      }
      if (state.phase === "NO_BOARDS" && event.type === "RETRY") {
        return { phase: "CLAIMING", demo: state.demo };
      }
      if (state.phase !== "IDLE" && event.type === "ACK") {
        return initialPlayState;
      }
      return state;

    case "PAUSED":
      if (event.type === "PLAY") return { phase: "CLAIMING", demo: event.demo };
      if (event.type === "ACK") return initialPlayState;
      return state;

    case "CLAIMING":
      switch (event.type) {
        case "CLAIM_READY":
          return {
            phase: "FOCUS",
            demo: event.claim.demo,
            claim: event.claim,
            selected: null,
          };
        case "NO_BOARDS":
          return {
            phase: "NO_BOARDS",
            demo: state.demo,
            retryAfterSeconds: event.retryAfterSeconds,
          };
        case "QUOTA_OUT":
          return {
            phase: "QUOTA_OUT",
            demo: state.demo,
            retryAfterSeconds: event.retryAfterSeconds,
          };
        case "PAUSED":
          return { phase: "PAUSED", demo: state.demo };
        default:
          return state;
      }

    case "FOCUS":
      switch (event.type) {
        case "SELECT":
          return { ...state, selected: event.square };
        case "MOVE_CHOSEN":
          return {
            ...state,
            phase: "CONFIRM",
            chosenMove: event.move,
            error: null,
          };
        case "CLAIM_EXPIRED":
          return { phase: "EXPIRED", demo: state.demo };
        case "CLAIM_REFRESHED":
          return {
            phase: "FOCUS",
            demo: event.claim.demo,
            claim: event.claim,
            selected: null,
          };
        default:
          return state;
      }

    case "CONFIRM":
      switch (event.type) {
        case "CHANGE_MOVE": {
          const { chosenMove: _dropped, ...rest } = state;
          return { ...rest, phase: "FOCUS", error: null };
        }
        case "CONFIRM":
          return state.demo
            ? { ...state, phase: "SETTLING", error: null }
            : { ...state, phase: "SIGNING", error: null };
        case "CLAIM_EXPIRED":
          return { phase: "EXPIRED", demo: state.demo };
        case "CLAIM_REFRESHED":
          return {
            phase: "FOCUS",
            demo: event.claim.demo,
            claim: event.claim,
            selected: null,
          };
        default:
          return state;
      }

    case "SIGNING":
      switch (event.type) {
        case "HEADER_READY":
          return { ...state, phase: "SETTLING", paymentHeader: event.header };
        case "WALLET_REJECTED":
          // Move preserved, timer still live (F-W10).
          return { ...state, phase: "CONFIRM" };
        case "CLAIM_EXPIRED":
          return { phase: "EXPIRED", demo: state.demo };
        default:
          return state;
      }

    case "SETTLING":
      switch (event.type) {
        case "RECEIPT": {
          const { paymentHeader: _dropped, ...rest } = state;
          return {
            ...rest,
            phase: "RECEIPT",
            receipt: event.receipt,
            settlePoll: false,
          };
        }
        case "PAYMENT_PENDING":
          return {
            ...state,
            settlePoll: true,
            retryAfterSeconds: event.retryAfterSeconds,
          };
        case "PAYMENT_IN_FLIGHT":
          return { ...state, settlePoll: true };
        case "PAYMENT_FAILED": {
          // Claim keeps ticking; the envelope hint renders in CONFIRM.
          // A definitively failed payment never resends its old bytes.
          const { paymentHeader: _dropped, ...rest } = state;
          return { ...rest, phase: "CONFIRM", error: event.envelope };
        }
        case "PAYMENT_UNAVAILABLE": {
          const { paymentHeader: _dropped, ...rest } = state;
          return {
            ...rest,
            phase: "CONFIRM",
            error: null,
            retryAfterSeconds: event.retryAfterSeconds,
          };
        }
        case "CLAIM_EXPIRED":
          return { phase: "EXPIRED", demo: state.demo };
        default:
          return state;
      }

    case "RECEIPT":
    case "EXPIRED":
      if (event.type === "ACK") return initialPlayState;
      if (event.type === "PLAY") return { phase: "CLAIMING", demo: event.demo };
      return state;

    default:
      return state;
  }
}
