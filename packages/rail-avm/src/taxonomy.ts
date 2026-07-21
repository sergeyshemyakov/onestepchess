import type { SettleResult, VerifyFailure } from "@onestepchess/core";

const INSUFFICIENT = /insufficient|overspend|balance below|underfunded/i;
const NOT_OPTED_IN = /not[ _-]?opted|opt[ _-]?in|asset holding/i;
const EXPIRED = /expired|validity|past (?:the )?last valid|round.*lapsed/i;

export function mapVerifyFailure(reason: string): VerifyFailure {
  if (INSUFFICIENT.test(reason)) return "insufficient_funds";
  if (NOT_OPTED_IN.test(reason)) return "not_opted_in";
  return "invalid_payment";
}

export function mapSettleFailure(
  reason: string,
): Extract<SettleResult, { readonly ok: false }>["reason"] {
  return EXPIRED.test(reason) ? "expired" : "rejected";
}
