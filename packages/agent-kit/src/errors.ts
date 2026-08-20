import type { Move } from "./schemas.js";

export const OSC_SERVER_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_ADDRESS",
  "INVALID_SIGNATURE",
  "NONCE_EXPIRED",
  "REKEYED_UNSUPPORTED",
  "REGISTRATION_REQUIRED",
  "TURNSTILE_FAILED",
  "INVALID_NICKNAME",
  "NICKNAME_TAKEN",
  "UNAUTHENTICATED",
  "BANNED",
  "NO_BOARDS",
  "QUOTA_OUT",
  "RATE_LIMITED",
  "RENAME_RATE_LIMITED",
  "DEMO_HUMANS_ONLY",
  "TURNSTILE_REQUIRED",
  "GUEST_DEMO_USED",
  "BONUS_NOT_ELIGIBLE",
  "BONUS_UNAVAILABLE",
  "NO_OPEN_CLAIM",
  "CLAIM_NOT_FOUND",
  "NOT_YOUR_CLAIM",
  "CLAIM_EXPIRED",
  "ENDPOINT_RETIRED",
  "ILLEGAL_MOVE",
  "AMBIGUOUS_MOVE",
  "PAYMENT_REQUIRED",
  "PAYMENT_INVALID",
  "INSUFFICIENT_FUNDS",
  "NOT_OPTED_IN",
  "PAYMENT_UNAVAILABLE",
  "PAYMENT_PENDING",
  "PAYMENT_IN_FLIGHT",
  "OPTIN_INVALID",
  "SWEEP_INVALID",
  "DEPENDENCY_UNAVAILABLE",
  "GAME_NOT_FOUND",
  "PAUSED",
  "INTERNAL",
] as const;

export type OscServerErrorCode = (typeof OSC_SERVER_ERROR_CODES)[number];
export type OscClientErrorCode =
  | "BUDGET_EXCEEDED"
  | "NETWORK_MISMATCH"
  | "KEYFILE_EXISTS"
  | "NO_WALLET"
  | "ALGO_SHORTFALL"
  | "ALGOD_UNAVAILABLE";

export class OscApiError extends Error {
  readonly code: OscServerErrorCode | (string & {});
  readonly hint: string;
  readonly docs: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly legalMoves?: Move[];
  readonly suggestion?: string;
  readonly requestId?: string;

  constructor(input: {
    code: OscServerErrorCode | (string & {});
    hint: string;
    docs: string;
    status: number;
    retryAfterSeconds?: number;
    legalMoves?: Move[];
    suggestion?: string;
    requestId?: string;
  }) {
    super(`${input.code}: ${input.hint}`);
    this.name = "OscApiError";
    this.code = input.code;
    this.hint = input.hint;
    this.docs = input.docs;
    this.status = input.status;
    if (input.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = input.retryAfterSeconds;
    }
    if (input.legalMoves !== undefined) this.legalMoves = input.legalMoves;
    if (input.suggestion !== undefined) this.suggestion = input.suggestion;
    if (input.requestId !== undefined) this.requestId = input.requestId;
  }
}

export class OscClientError extends Error {
  readonly code: OscClientErrorCode;
  readonly hint: string;
  readonly detail?: string;

  constructor(code: OscClientErrorCode, hint: string, detail?: string) {
    super(`${code}: ${hint}`);
    this.name = "OscClientError";
    this.code = code;
    this.hint = hint;
    if (detail !== undefined) this.detail = detail;
  }
}
