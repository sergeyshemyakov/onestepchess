import { ExactAvmScheme } from "@x402-avm/avm";
import { encodePaymentSignatureHeader } from "@x402-avm/core/http";
import type {
  PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
} from "@x402-avm/core/types";
import algosdk from "algosdk";
import type { ApiClient } from "../api/client.js";
import type {
  ErrorEnvelope,
  Meta,
  MoveReceipt,
  PaymentRequired,
  PaymentRequirements,
} from "../api/schemas.js";
import { paymentRequiredSchema } from "../api/schemas.js";
import type { ConnectedWallet } from "./provider.js";

const X402_GLOBAL_CHALLENGE_TAG = "x402-global-challenge";
const MOVE_RESOURCE_DESCRIPTION =
  "Submit one legal move to an active shared One Step Chess game and receive the committed move and Algorand settlement receipt.";

// §5.6 — the explicit x402 client. The mock branch (rail spec §5.4) is a
// pinned wire contract implemented from the spec: it synthesizes the V2
// payload and never loads wallet code or signs anything. `exact` is real
// payments (Release 4) and fails loudly instead of dead-ending a wallet UI.

/** Signed headers cached in memory per claim — retries resend the identical
 * bytes (PAYMENT_IN_FLIGHT discipline); never persisted (§5.5). */
const headerCache = new Map<string, string>();
const staleRebuilds = new Set<string>();

export function cachedHeaderFor(claimId: string): string | undefined {
  return headerCache.get(claimId);
}

export function resetHeaderCacheForTests(): void {
  headerCache.clear();
  staleRebuilds.clear();
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
    const resource = new URL(required.resource.url);
    if (resource.search !== "" || resource.hash !== "") {
      return { ok: false, reason: "challenge resource is not canonical" };
    }
    resourcePath = resource.pathname;
  } catch {
    return { ok: false, reason: "challenge resource is not a URL" };
  }
  if (resourcePath !== `/api/v1/claims/${args.claimId}/move`) {
    return {
      ok: false,
      reason: "challenge resource is not this claim's move URL",
    };
  }
  if (
    required.resource.description !== MOVE_RESOURCE_DESCRIPTION ||
    required.resource.mimeType !== "application/json"
  ) {
    return { ok: false, reason: "challenge resource metadata is invalid" };
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
  if (requirement.network !== args.meta.network.caip2) {
    return {
      ok: false,
      reason: "challenge network is not the runtime network",
    };
  }
  if (requirement.extra?.tag !== X402_GLOBAL_CHALLENGE_TAG) {
    return { ok: false, reason: "challenge tag is invalid" };
  }
  if (requirement.scheme === "exact") {
    const feePayer = requirement.extra?.feePayer;
    if (
      typeof feePayer !== "string" ||
      !algosdk.isValidAddress(feePayer) ||
      requirement.extra?.decimals !== 6
    ) {
      return {
        ok: false,
        reason: "exact challenge has unsafe fee-payer parameters",
      };
    }
  }
  return { ok: true, required, requirement };
}

function encodedGenesis(transaction: algosdk.Transaction): string {
  return bytesToBase64(transaction.genesisHash ?? new Uint8Array());
}

function noteText(transaction: algosdk.Transaction): string {
  return new TextDecoder().decode(transaction.note ?? new Uint8Array());
}

function assertNoUnsafeFields(transaction: algosdk.Transaction): void {
  if (
    transaction.rekeyTo !== undefined ||
    (transaction.lease !== undefined && transaction.lease.length > 0) ||
    transaction.payment?.closeRemainderTo !== undefined ||
    transaction.assetTransfer?.closeRemainderTo !== undefined ||
    transaction.assetTransfer?.assetSender !== undefined
  ) {
    throw new Error("exact payment contains an unsafe transaction field");
  }
}

/** The x402 library builds the group, but this guard owns the browser trust
 * boundary. It runs inside the signer adapter before wallet approval. */
export function guardExactPaymentGroup(input: {
  readonly txns: Uint8Array[];
  readonly indexesToSign?: number[];
  readonly requirement: PaymentRequirements;
  readonly signerAddress: string;
}): algosdk.Transaction[] {
  if (
    input.txns.length !== 2 ||
    input.indexesToSign?.length !== 1 ||
    input.indexesToSign[0] !== 1
  ) {
    throw new Error(
      "exact payment must contain two grouped transactions and one client signature",
    );
  }
  let transactions: algosdk.Transaction[];
  try {
    transactions = input.txns.map((bytes) =>
      algosdk.decodeUnsignedTransaction(bytes),
    );
  } catch {
    throw new Error("exact payment group is malformed");
  }
  const feeTransaction = transactions[0];
  const paymentTransaction = transactions[1];
  const feePayer = input.requirement.extra?.feePayer;
  const genesis = input.requirement.network.split(":")[1] ?? "";
  if (
    feeTransaction === undefined ||
    paymentTransaction === undefined ||
    feeTransaction.type !== "pay" ||
    feeTransaction.payment === undefined ||
    paymentTransaction.type !== "axfer" ||
    paymentTransaction.assetTransfer === undefined ||
    typeof feePayer !== "string" ||
    feeTransaction.sender.toString() !== feePayer ||
    feeTransaction.payment.receiver.toString() !== feePayer ||
    feeTransaction.payment.amount !== 0n ||
    feeTransaction.fee < 2_000n ||
    paymentTransaction.sender.toString() !== input.signerAddress ||
    paymentTransaction.assetTransfer.receiver.toString() !==
      input.requirement.payTo ||
    paymentTransaction.assetTransfer.amount.toString() !==
      input.requirement.amount ||
    paymentTransaction.assetTransfer.assetIndex.toString() !==
      input.requirement.asset ||
    paymentTransaction.fee !== 0n ||
    paymentTransaction.firstValid > paymentTransaction.lastValid ||
    paymentTransaction.lastValid - paymentTransaction.firstValid > 1_000n ||
    feeTransaction.firstValid !== paymentTransaction.firstValid ||
    feeTransaction.lastValid !== paymentTransaction.lastValid ||
    encodedGenesis(feeTransaction) !== genesis ||
    encodedGenesis(paymentTransaction) !== genesis ||
    feeTransaction.genesisID !== paymentTransaction.genesisID ||
    feeTransaction.group === undefined ||
    paymentTransaction.group === undefined ||
    !bytesEqual(feeTransaction.group, paymentTransaction.group) ||
    !noteText(feeTransaction).startsWith("x402-fee-payer-") ||
    !noteText(paymentTransaction).startsWith("x402-payment-v2-")
  ) {
    throw new Error("exact payment group failed the local trust guard");
  }
  assertNoUnsafeFields(feeTransaction);
  assertNoUnsafeFields(paymentTransaction);
  return transactions;
}

async function buildExactHeader(input: {
  readonly required: PaymentRequired;
  readonly requirement: PaymentRequirements;
  readonly getSigner: () => Promise<ConnectedWallet>;
  readonly expectedAddress: string;
  readonly algodUrl: string;
  readonly onPhase?: (phase: "building" | "signing" | "settling") => void;
}): Promise<string> {
  const wallet = await input.getSigner();
  if (wallet.address !== input.expectedAddress) {
    throw new Error("connected wallet does not match this account");
  }
  input.onPhase?.("signing");
  const avmSigner = {
    address: wallet.address,
    signTransactions: async (
      txns: Uint8Array[],
      indexesToSign?: number[],
    ): Promise<(Uint8Array | null)[]> => {
      const transactions = guardExactPaymentGroup({
        txns,
        indexesToSign,
        requirement: input.requirement,
        signerAddress: wallet.address,
      });
      const signed = await wallet.signTransactions(transactions, [1]);
      return [null, signed];
    },
  };
  const scheme = new ExactAvmScheme(avmSigner, {
    algodUrl: input.algodUrl,
  });
  const built = await scheme.createPaymentPayload(
    2,
    input.requirement as X402PaymentRequirements,
  );
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: input.required.resource,
    accepted: input.requirement as X402PaymentRequirements,
    payload: built.payload,
    extensions: input.required.extensions,
  };
  return encodePaymentSignatureHeader(payload);
}

async function headerFromChallenge(
  challengeHeader: string,
  args: Parameters<typeof payMove>[0],
): Promise<
  | { readonly ok: true; readonly header: string }
  | { readonly ok: false; readonly outcome: PayMoveOutcome }
> {
  const validated = validateChallenge(challengeHeader, args);
  if (!validated.ok) {
    return {
      ok: false,
      outcome: {
        kind: "failed",
        envelope: challengeEnvelope(validated.reason),
      },
    };
  }
  if (validated.requirement.scheme === "mock") {
    return {
      ok: true,
      header: synthesizeMockHeader({
        required: validated.required,
        requirement: validated.requirement,
        from: args.address,
      }),
    };
  }
  if (validated.requirement.scheme !== "exact") {
    return {
      ok: false,
      outcome: {
        kind: "failed",
        envelope: challengeEnvelope(
          `unknown payment scheme: ${validated.requirement.scheme}`,
        ),
      },
    };
  }
  if (args.getSigner === undefined) {
    return {
      ok: false,
      outcome: { kind: "wallet_disconnected" },
    };
  }
  try {
    return {
      ok: true,
      header: await buildExactHeader({
        required: validated.required,
        requirement: validated.requirement,
        getSigner: args.getSigner,
        expectedAddress: args.address,
        algodUrl: args.meta.network.algodUrl,
        ...(args.onPhase === undefined ? {} : { onPhase: args.onPhase }),
      }),
    };
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      return { ok: false, outcome: { kind: "wallet_rejected" } };
    }
    throw cause;
  }
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
    extensions: args.required.extensions,
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
  | { readonly kind: "wallet_rejected" }
  | { readonly kind: "wallet_disconnected" };

export async function payMove(args: {
  readonly claimId: string;
  readonly moveUci: string;
  readonly address: string;
  readonly stakeMicroUsdc: number;
  readonly meta: Meta;
  readonly client: Pick<ApiClient, "postMove">;
  /** Lazy wallet signer — never called for the mock scheme. */
  readonly getSigner?: () => Promise<ConnectedWallet>;
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
        const built = await headerFromChallenge(first.challengeHeader, args);
        if (!built.ok) return built.outcome;
        header = built.header;
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
      staleRebuilds.delete(args.claimId);
      return { kind: "receipt", receipt: settled.receipt };
    case "pending":
      // Ambiguous outcome: keep the exact bytes, poll status, never re-sign.
      return { kind: "pending", retryAfterSeconds: settled.retryAfterSeconds };
    case "in_flight":
      return { kind: "in_flight" };
    case "payment_failed":
      headerCache.delete(args.claimId);
      if (
        settled.code === "PAYMENT_INVALID" &&
        !staleRebuilds.has(args.claimId)
      ) {
        staleRebuilds.add(args.claimId);
        if (settled.challengeHeader !== null) {
          const rebuilt = await headerFromChallenge(
            settled.challengeHeader,
            args,
          );
          if (!rebuilt.ok) return rebuilt.outcome;
          headerCache.set(args.claimId, rebuilt.header);
          return payMove(args);
        }
        return payMove(args);
      }
      return { kind: "failed", envelope: settled.envelope };
    case "unavailable":
      // Definitively uncharged; the same bytes may be resent later.
      return {
        kind: "unavailable",
        retryAfterSeconds: settled.retryAfterSeconds,
      };
    case "expired":
      headerCache.delete(args.claimId);
      staleRebuilds.delete(args.claimId);
      return { kind: "expired" };
    case "paused":
      return { kind: "paused" };
    case "illegal":
      headerCache.delete(args.claimId);
      return { kind: "illegal", envelope: settled.envelope };
    case "payment_required":
      headerCache.delete(args.claimId);
      if (!staleRebuilds.has(args.claimId)) {
        staleRebuilds.add(args.claimId);
        const rebuilt = await headerFromChallenge(
          settled.challengeHeader,
          args,
        );
        if (!rebuilt.ok) return rebuilt.outcome;
        headerCache.set(args.claimId, rebuilt.header);
        return payMove(args);
      }
      return {
        kind: "failed",
        envelope: challengeEnvelope("payment was not accepted — try again"),
      };
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function challengeEnvelope(reason: string): ErrorEnvelope {
  return { error: "PAYMENT_INVALID", hint: reason, docs: "" };
}
