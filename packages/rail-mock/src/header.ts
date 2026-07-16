import { Buffer } from "node:buffer";
import type {
  DecodeResult,
  PaymentChallenge,
  PaymentRequired,
  PaymentRequirements,
} from "@onestepchess/core";
import { RailError } from "@onestepchess/core";

export const MOCK_SCHEME = "mock";
export const MOCK_NETWORK = "mock:local";

type MockPayload = {
  readonly from: string;
  readonly amountMicroUsdc: number;
  readonly asset: string;
  readonly payTo: string;
  readonly nonce: string;
};

type MockPaymentSignature = {
  readonly x402Version: 2;
  readonly resource: { readonly url: string };
  readonly accepted: PaymentRequirements;
  readonly payload: MockPayload;
};

let nextNonce = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPaymentRequirements(value: unknown): value is PaymentRequirements {
  if (!isRecord(value) || !isRecord(value.extra)) {
    return false;
  }
  return (
    value.scheme === MOCK_SCHEME &&
    value.network === MOCK_NETWORK &&
    isNonEmptyString(value.asset) &&
    isNonEmptyString(value.amount) &&
    isNonEmptyString(value.payTo) &&
    typeof value.maxTimeoutSeconds === "number" &&
    Number.isFinite(value.maxTimeoutSeconds)
  );
}

function parseMockSignature(value: unknown): MockPaymentSignature | null {
  if (!isRecord(value) || value.x402Version !== 2) {
    return null;
  }
  const { resource, accepted, payload } = value;
  if (
    !isRecord(resource) ||
    !isNonEmptyString(resource.url) ||
    !isPaymentRequirements(accepted) ||
    !isRecord(payload) ||
    !isNonEmptyString(payload.from) ||
    !Number.isSafeInteger(payload.amountMicroUsdc) ||
    (payload.amountMicroUsdc as number) <= 0 ||
    !isNonEmptyString(payload.asset) ||
    !isNonEmptyString(payload.payTo) ||
    !isNonEmptyString(payload.nonce)
  ) {
    return null;
  }
  return value as MockPaymentSignature;
}

export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeBase64Json(encoded: string): unknown {
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error("invalid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error("non-canonical base64");
  }
  return JSON.parse(bytes.toString("utf8"));
}

export function decodeMockPayment(header: string): DecodeResult {
  try {
    const signature = parseMockSignature(decodeBase64Json(header));
    if (signature === null) {
      return { ok: false, reason: "malformed" };
    }
    return {
      ok: true,
      payment: {
        clientTxId: `mockpay_${signature.payload.nonce}`,
        sender: signature.payload.from,
        amountMicroUsdc: signature.payload.amountMicroUsdc,
        asset: signature.payload.asset,
        payTo: signature.payload.payTo,
        lastValidRound: null,
      },
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export function matchesMockPaymentRequirement(
  header: string,
  required: PaymentRequired,
): boolean {
  try {
    const signature = parseMockSignature(decodeBase64Json(header));
    if (signature === null) return false;
    const accepted = required.accepts[0];
    return (
      signature.resource.url === required.resource.url &&
      signature.accepted.scheme === accepted.scheme &&
      signature.accepted.network === accepted.network &&
      signature.accepted.asset === accepted.asset &&
      signature.accepted.amount === accepted.amount &&
      signature.accepted.payTo === accepted.payTo &&
      signature.accepted.maxTimeoutSeconds === accepted.maxTimeoutSeconds &&
      JSON.stringify(signature.accepted.extra) ===
        JSON.stringify(accepted.extra) &&
      signature.payload.amountMicroUsdc === Number(accepted.amount) &&
      signature.payload.asset === accepted.asset &&
      signature.payload.payTo === accepted.payTo
    );
  } catch {
    return false;
  }
}

export function buildMockHeader(input: {
  readonly challenge: PaymentChallenge;
  readonly from: string;
  readonly nonce?: string;
}): string {
  const accepted = input.challenge.required.accepts[0];
  const amountMicroUsdc = Number(accepted.amount);
  const nonce = input.nonce ?? `nonce_${String(nextNonce++).padStart(6, "0")}`;
  if (
    !isNonEmptyString(input.from) ||
    !isNonEmptyString(nonce) ||
    accepted.scheme !== MOCK_SCHEME ||
    accepted.network !== MOCK_NETWORK ||
    !Number.isSafeInteger(amountMicroUsdc) ||
    amountMicroUsdc <= 0
  ) {
    throw new RailError("CONTRACT", "Invalid mock payment header input");
  }
  return encodeBase64Json({
    x402Version: 2,
    resource: input.challenge.required.resource,
    accepted,
    payload: {
      from: input.from,
      amountMicroUsdc,
      asset: accepted.asset,
      payTo: accepted.payTo,
      nonce,
    },
  } satisfies MockPaymentSignature);
}
