export type Side = "white" | "black";
export type GameResult = "white" | "black" | "draw" | "aborted";
export type Termination =
  | "checkmate"
  | "stalemate"
  | "insufficient"
  | "threefold"
  | "fifty_move"
  | "max_plies"
  | "aborted";
export type Phase = "normal" | "endspiel";
export type GameStatus = "active" | "endspiel" | "finished" | "aborted";
export type ClaimStatus = "open" | "moved" | "expired";
export type IntentStatus = "verified" | "settling" | "settled" | "failed";
export type PayoutStatus =
  | "pending"
  | "prepared"
  | "submitted"
  | "confirmed"
  | "failed";
export type PlayerKind = "human" | "agent" | "guest";
export type StakeKind = "human" | "agent";

export type MicroUsdc = number;
export type EpochMs = number;
export type Uci = string;
export type San = string;
export type Move = { readonly uci: Uci; readonly san: San };

export const STARTING_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function opposite(side: Side): Side {
  return side === "white" ? "black" : "white";
}

export type CoreErrorCode =
  | "CORRUPT_HISTORY"
  | "ILLEGAL_APPLY"
  | "CONSERVATION"
  | "CONTRACT";

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}
