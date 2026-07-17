import type { ApiClient } from "../api/client.js";
import type {
  ErrorEnvelope,
  Meta,
  MoveReceipt,
  PaymentRequired,
  PaymentRequirements,
} from "../api/schemas.js";
import { paymentRequiredSchema } from "../api/schemas.js";

// §5.6 — the explicit x402 client. The mock branch (rail spec §5.4) is a
// pinned wire contract implemented from the spec: it synthesizes the V2
// payload and never loads wallet code or signs anything. `exact` is real
// payments (Release 4) and fails loudly instead of dead-ending a wallet UI.

/** Signed headers cached in memory per claim — retries resend the identical
 * bytes (PAYMENT_IN_FLIGHT discipline); never persisted (§5.5). */
const headerCache = new Map<string, string>();

export function cachedHeaderFor(claimId: string): string | undefined {
  return headerCache.get(claimId);
}

export function resetHeaderCacheForTests(): void {
  headerCache.clear();
}

function decodeBase64Json(encoded: string): unknown {
  return JSON.parse(atob(encoded));
}

function encodeBase64Json(value: unknown): string {
  return btoa(JSON.stringify(value));
}

export type ChallengeValidation =
  | {
      readonly ok: true;
      readonly required: PaymentRequired;
      readonly requirement: PaymentRequirements;
    }
  | { readonly ok: false; readonly reason: string };

/** Validate the 402 challenge against the claim and the `/meta` trust pins —
 * every mismatch rejects locally before any signer or network retry. */
export function validateChallenge(
  headerB64: string,
  args: {
    readonly claimId: string;
    readonly stakeMicroUsdc: number;
    readonly meta: Meta;
  },
): ChallengeValidation {
  let decoded: unknown;
  try {
    decoded = decodeBase64Json(headerB64);
  } catch {
    return { ok: false, reason: "challenge is not decodable" };
  }
  const parsed = paymentRequiredSchema.safeParse(decoded);
  if (!parsed.success) {
    return { ok: false, reason: "challenge is not a V2 payment-required" };
  }
  const required = parsed.data;
  if (required.accepts.length !== 1) {
    return {
      ok: false,
      reason: "challenge must offer exactly one requirement",
    };
  }
  const requirement = required.accepts[0];
  if (requirement === undefined) {
    return {
      ok: false,
      reason: "challenge must offer exactly one requirement",
    };
  }
  let resourcePath: string;
  try {
    resourcePath = new URL(required.resource.url).pathname;
  } catch {
    return { ok: false, reason: "challenge resource is not a URL" };
  }
  if (resourcePath !== `/api/v1/claims/${args.claimId}/move`) {
    return {
      ok: false,
      reason: "challenge resource is not this claim's move URL",
    };
  }
  if (requirement.amount !== String(args.stakeMicroUsdc)) {
    return {
      ok: false,
      reason: "challenge amount differs from the claim stake",
    };
  }
  if (requirement.payTo !== args.meta.network.treasuryAddress) {
    return { ok: false, reason: "challenge payTo is not the pinned treasury" };
  }
  if (requirement.asset !== args.meta.network.usdcAssetId) {
    return {
      ok: false,
      reason: "challenge asset is not the pinned USDC asset",
    };
  }
  return { ok: true, required, requirement };
}

/** Rail spec §5.4: the pinned mock payload with a client-unique nonce. */
export function synthesizeMockHeader(args: {
  readonly required: PaymentRequired;
  readonly requirement: PaymentRequirements;
  readonly from: string;
}): string {
  const nonce = `web-${crypto.randomUUID()}`;
  return encodeBase64Json({
    x402Version: 2,
    resource: args.required.resource,
    accepted: args.requirement,
    payload: {
      from: args.from,
      amountMicroUsdc: Number(args.requirement.amount),
      asset: args.requirement.asset,
      payTo: args.requirement.payTo,
      nonce,
    },
  });
}

export type PayMoveOutcome =
  | { readonly kind: "receipt"; readonly receipt: MoveReceipt }
  | { readonly kind: "pending"; readonly retryAfterSeconds: number }
  | { readonly kind: "in_flight" }
  | { readonly kind: "failed"; readonly envelope: ErrorEnvelope }
  | { readonly kind: "unavailable"; readonly retryAfterSeconds: number }
  | { readonly kind: "expired" }
  | { readonly kind: "paused" }
  | { readonly kind: "illegal"; readonly envelope: ErrorEnvelope }
  | { readonly kind: "unsupported"; readonly reason: string };

export async function payMove(args: {
  readonly claimId: string;
  readonly moveUci: string;
  readonly address: string;
  readonly stakeMicroUsdc: number;
  readonly meta: Meta;
  readonly client: Pick<ApiClient, "postMove">;
  /** Lazy wallet signer — never called for the mock scheme. */
  readonly getSigner?: () => Promise<unknown>;
  readonly onPhase?: (phase: "building" | "signing" | "settling") => void;
}): Promise<PayMoveOutcome> {
  const cached = headerCache.get(args.claimId);
  let header: string;

  if (cached !== undefined) {
    header = cached;
  } else {
    args.onPhase?.("building");
    const first = await args.client.postMove(args.claimId, args.moveUci);
    switch (first.kind) {
      case "receipt":
        return { kind: "receipt", receipt: first.receipt };
      case "payment_required": {
        const validated = validateChallenge(first.challengeHeader, args);
        if (!validated.ok) {
          return {
            kind: "failed",
            envelope: challengeEnvelope(validated.reason),
          };
        }
        const scheme = validated.requirement.scheme;
        if (scheme === "mock") {
          // Dev/CI-only wire contract: synthesize, skip wallet entirely.
          header = synthesizeMockHeader({
            required: validated.required,
            requirement: validated.requirement,
            from: args.address,
          });
        } else if (scheme === "exact") {
          // Real payments are Release 4 — no silent fallthrough (§1.1).
          return {
            kind: "unsupported",
            reason: "real payments are not supported in this build",
          };
        } else {
          return {
            kind: "failed",
            envelope: challengeEnvelope(`unknown payment scheme: ${scheme}`),
          };
        }
        headerCache.set(args.claimId, header);
        break;
      }
      case "pending":
        return { kind: "pending", retryAfterSeconds: first.retryAfterSeconds };
      case "in_flight":
        return { kind: "in_flight" };
      case "expired":
        return { kind: "expired" };
      case "paused":
        return { kind: "paused" };
      case "illegal":
        return { kind: "illegal", envelope: first.envelope };
      case "payment_failed":
        return { kind: "failed", envelope: first.envelope };
      case "unavailable":
        return {
          kind: "unavailable",
          retryAfterSeconds: first.retryAfterSeconds,
        };
    }
  }

  args.onPhase?.("settling");
  const settled = await args.client.postMove(
    args.claimId,
    args.moveUci,
    header,
  );
  switch (settled.kind) {
    case "receipt":
      headerCache.delete(args.claimId);
      return { kind: "receipt", receipt: settled.receipt };
    case "pending":
      // Ambiguous outcome: keep the exact bytes, poll status, never re-sign.
      return { kind: "pending", retryAfterSeconds: settled.retryAfterSeconds };
    case "in_flight":
      return { kind: "in_flight" };
    case "payment_failed":
      // Definitive failure burns this payload — a retry builds a fresh one.
      headerCache.delete(args.claimId);
      return { kind: "failed", envelope: settled.envelope };
    case "unavailable":
      // Definitively uncharged; the same bytes may be resent later.
      return {
        kind: "unavailable",
        retryAfterSeconds: settled.retryAfterSeconds,
      };
    case "expired":
      headerCache.delete(args.claimId);
      return { kind: "expired" };
    case "paused":
      return { kind: "paused" };
    case "illegal":
      headerCache.delete(args.claimId);
      return { kind: "illegal", envelope: settled.envelope };
    case "payment_required":
      // A fresh challenge after we sent a header means the intent vanished —
      // treat as a failed payment and rebuild next attempt.
      headerCache.delete(args.claimId);
      return {
        kind: "failed",
        envelope: challengeEnvelope("payment was not accepted — try again"),
      };
  }
}

function challengeEnvelope(reason: string): ErrorEnvelope {
  return { error: "PAYMENT_INVALID", hint: reason, docs: "" };
}
