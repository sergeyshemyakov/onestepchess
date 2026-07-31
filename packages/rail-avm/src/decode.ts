import type { DecodeResult, PaymentRequirements } from "@onestepchess/core";
import algosdk from "algosdk";
import { z } from "zod";

const requirementsSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number(),
  extra: z.record(z.string(), z.unknown()),
});

const exactPaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({
    url: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  accepted: requirementsSchema,
  payload: z.object({
    paymentGroup: z.array(z.string()).min(1).max(16),
    paymentIndex: z.number().int().nonnegative(),
  }),
});

export type ExactPaymentPayload = z.infer<typeof exactPaymentPayloadSchema>;

function decodeBase64(value: string): Buffer | null {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

export function parsePaymentHeader(header: string): ExactPaymentPayload | null {
  try {
    const bytes = decodeBase64(header);
    if (bytes === null) return null;
    const parsed = exactPaymentPayloadSchema.safeParse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (!parsed.success) return null;
    if (
      parsed.data.payload.paymentIndex >=
      parsed.data.payload.paymentGroup.length
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function decodeTransaction(bytes: Uint8Array): algosdk.Transaction {
  try {
    return algosdk.decodeSignedTransaction(bytes).txn;
  } catch {
    return algosdk.decodeUnsignedTransaction(bytes);
  }
}

export function decodeTransactionB64(
  value: string,
): algosdk.Transaction | null {
  try {
    const bytes = decodeBase64(value);
    return bytes === null ? null : decodeTransaction(bytes);
  } catch {
    return null;
  }
}

function safeNumber(value: bigint): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function decodePayment(header: string): DecodeResult {
  try {
    const payload = parsePaymentHeader(header);
    if (payload === null) return { ok: false, reason: "malformed" };
    const encoded = payload.payload.paymentGroup[payload.payload.paymentIndex];
    if (encoded === undefined) return { ok: false, reason: "malformed" };
    const bytes = decodeBase64(encoded);
    if (bytes === null) return { ok: false, reason: "malformed" };
    const transaction = decodeTransaction(bytes);
    const transfer = transaction.assetTransfer;
    if (transfer === undefined) return { ok: false, reason: "malformed" };
    const amount = safeNumber(transfer.amount);
    const lastValidRound = safeNumber(transaction.lastValid);
    if (amount === null || lastValidRound === null) {
      return { ok: false, reason: "malformed" };
    }
    return {
      ok: true,
      payment: {
        clientTxId: transaction.txID(),
        sender: transaction.sender.toString(),
        amountMicroUsdc: amount,
        asset: transfer.assetIndex.toString(),
        payTo: transfer.receiver.toString(),
        lastValidRound,
      },
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export function acceptedRequirement(
  header: string,
): PaymentRequirements | null {
  return parsePaymentHeader(header)?.accepted ?? null;
}
