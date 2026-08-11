import { randomUUID } from "node:crypto";
import { ExactAvmScheme } from "@x402-avm/avm";
import { encodePaymentSignatureHeader } from "@x402-avm/core/http";
import type {
  PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
} from "@x402-avm/core/types";
import algosdk from "algosdk";
import type { Signer } from "./auth.js";
import { OscClientError } from "./errors.js";
import {
  type ClaimView,
  type Meta,
  type PaymentRequired,
  type PaymentRequirements,
  paymentRequiredSchema,
  paymentResponseSchema,
} from "./schemas.js";

export const MAINNET_CAIP2 =
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
export const TESTNET_CAIP2 =
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
export const MAINNET_USDC_ASSET = "31566704";
export const TESTNET_USDC_ASSET = "10458941";
const X402_GLOBAL_CHALLENGE_TAG = "x402-global-challenge";
const MOVE_RESOURCE_DESCRIPTION =
  "Submit one legal move to an active shared One Step Chess game and receive the committed move and Algorand settlement receipt.";

const NETWORK_LABELS = new Map<string, "mainnet" | "testnet" | "mock">([
  [MAINNET_CAIP2, "mainnet"],
  [TESTNET_CAIP2, "testnet"],
  ["mock:local", "mock"],
]);

const DEFAULT_ALGOD_URLS = new Map([
  [MAINNET_CAIP2, "https://mainnet-api.4160.nodely.dev"],
  [TESTNET_CAIP2, "https://testnet-api.4160.nodely.dev"],
]);

export function assertSupportedNetwork(input: {
  readonly meta: Meta;
  readonly expectNetwork?: "mainnet" | "testnet" | "mock";
}): "mainnet" | "testnet" | "mock" {
  const label = NETWORK_LABELS.get(input.meta.network.caip2);
  if (label === undefined) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      `unsupported server network ${input.meta.network.caip2}`,
    );
  }
  if (input.expectNetwork !== undefined && label !== input.expectNetwork) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      `server network does not match the ${input.expectNetwork} pin`,
    );
  }
  const expectedAsset =
    label === "mainnet"
      ? MAINNET_USDC_ASSET
      : label === "testnet"
        ? TESTNET_USDC_ASSET
        : input.meta.network.usdcAssetId;
  if (input.meta.network.usdcAssetId !== expectedAsset) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      `server USDC asset does not match the ${label} allowlist`,
    );
  }
  if (
    label !== "mock" &&
    !algosdk.isValidAddress(input.meta.network.treasuryAddress)
  ) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "server treasury is not a valid Algorand address",
    );
  }
  return label;
}

export function resolveAlgodUrl(meta: Meta, override?: string): string {
  assertSupportedNetwork({ meta });
  const resolved =
    override ??
    meta.network.algodUrl ??
    DEFAULT_ALGOD_URLS.get(meta.network.caip2);
  if (resolved === undefined) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      `no algod endpoint is known for ${meta.network.caip2}`,
    );
  }
  return resolved.replace(/\/+$/, "");
}

function decodeHeader<T>(
  header: string,
  parser: { parse(value: unknown): T },
  name: string,
): T {
  try {
    return parser.parse(JSON.parse(Buffer.from(header, "base64").toString()));
  } catch {
    throw new OscClientError("NETWORK_MISMATCH", `${name} is malformed`);
  }
}

export function decodePaymentRequired(header: string): PaymentRequired {
  return decodeHeader(header, paymentRequiredSchema, "PAYMENT-REQUIRED");
}

export function decodePaymentResponse(header: string) {
  return decodeHeader(header, paymentResponseSchema, "PAYMENT-RESPONSE");
}

export function assertTrustedPayment(input: {
  readonly paymentRequired: PaymentRequired;
  readonly claim: ClaimView;
  readonly meta: Meta;
  readonly resourceUrl: string;
  readonly expectNetwork?: "mainnet" | "testnet" | "mock";
}): PaymentRequirements {
  const label = assertSupportedNetwork({
    meta: input.meta,
    ...(input.expectNetwork === undefined
      ? {}
      : { expectNetwork: input.expectNetwork }),
  });
  const requirement = input.paymentRequired.accepts[0];
  if (requirement === undefined) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "payment challenge has no accepted requirement",
    );
  }
  const mismatch = (field: string, expected: string, actual: string): never => {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      `payment ${field} mismatch`,
      `expected ${expected}; got ${actual}`,
    );
  };

  if (requirement.amount !== String(input.claim.stakeMicroUsdc)) {
    mismatch("amount", String(input.claim.stakeMicroUsdc), requirement.amount);
  }
  if (requirement.network !== input.meta.network.caip2) {
    mismatch("network", input.meta.network.caip2, requirement.network);
  }
  if (input.paymentRequired.resource.url !== input.resourceUrl) {
    mismatch("resource", input.resourceUrl, input.paymentRequired.resource.url);
  }
  if (
    input.paymentRequired.resource.description !== MOVE_RESOURCE_DESCRIPTION ||
    input.paymentRequired.resource.mimeType !== "application/json"
  ) {
    mismatch(
      "resource metadata",
      `${MOVE_RESOURCE_DESCRIPTION}; application/json`,
      `${input.paymentRequired.resource.description ?? "missing"}; ${input.paymentRequired.resource.mimeType ?? "missing"}`,
    );
  }
  if (
    requirement.payTo !== input.meta.network.treasuryAddress ||
    (requirement.network !== "mock:local" &&
      !algosdk.isValidAddress(requirement.payTo))
  ) {
    mismatch("payTo", input.meta.network.treasuryAddress, requirement.payTo);
  }

  const requirementLabel =
    NETWORK_LABELS.get(requirement.network) ??
    mismatch(
      "network allowlist",
      "known Algorand USDC network",
      requirement.network,
    );
  if (requirementLabel !== label)
    mismatch("network pin", label, requirementLabel);
  const assetAllowed =
    (requirement.network === MAINNET_CAIP2 &&
      requirement.asset === MAINNET_USDC_ASSET) ||
    (requirement.network === TESTNET_CAIP2 &&
      requirement.asset === TESTNET_USDC_ASSET) ||
    requirement.network === "mock:local";
  if (!assetAllowed || requirement.asset !== input.meta.network.usdcAssetId) {
    mismatch("asset", input.meta.network.usdcAssetId, requirement.asset);
  }
  if (requirement.extra.tag !== X402_GLOBAL_CHALLENGE_TAG) {
    mismatch(
      "challenge tag",
      X402_GLOBAL_CHALLENGE_TAG,
      String(requirement.extra.tag),
    );
  }
  if (requirement.scheme === "exact") {
    const feePayer = requirement.extra.feePayer;
    if (
      typeof feePayer !== "string" ||
      !algosdk.isValidAddress(feePayer) ||
      requirement.extra.decimals !== 6
    ) {
      mismatch("feePayer", "valid Algorand address", String(feePayer));
    }
  }
  return requirement;
}

function assertAbsentUnsafeFields(transaction: algosdk.Transaction): void {
  if (
    transaction.rekeyTo !== undefined ||
    transaction.lease !== undefined ||
    transaction.payment?.closeRemainderTo !== undefined ||
    transaction.assetTransfer?.closeRemainderTo !== undefined ||
    transaction.assetTransfer?.assetSender !== undefined
  ) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "exact payment transaction contains an unsafe field",
    );
  }
}

function guardExactGroup(input: {
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
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "exact payment must be a two-transaction group with only the client leg signed",
    );
  }
  let transactions: algosdk.Transaction[];
  try {
    transactions = input.txns.map((bytes) =>
      algosdk.decodeUnsignedTransaction(bytes),
    );
  } catch {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "exact payment group could not be decoded",
    );
  }
  const feeTransaction = transactions[0];
  const paymentTransaction = transactions[1];
  if (
    feeTransaction === undefined ||
    paymentTransaction === undefined ||
    feeTransaction.type !== "pay" ||
    paymentTransaction.type !== "axfer" ||
    feeTransaction.payment === undefined ||
    paymentTransaction.assetTransfer === undefined
  ) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "exact payment group has the wrong transaction types",
    );
  }
  const feePayer = input.requirement.extra.feePayer;
  const genesis = input.requirement.network.split(":")[1] ?? "";
  const encodedGenesis = (transaction: algosdk.Transaction) =>
    Buffer.from(transaction.genesisHash ?? new Uint8Array()).toString("base64");
  const noteText = (transaction: algosdk.Transaction) =>
    new TextDecoder().decode(transaction.note ?? new Uint8Array());
  if (
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
    Buffer.compare(
      Buffer.from(feeTransaction.group),
      Buffer.from(paymentTransaction.group),
    ) !== 0 ||
    !noteText(feeTransaction).startsWith("x402-fee-payer-") ||
    !noteText(paymentTransaction).startsWith("x402-payment-v2-")
  ) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "exact payment group failed the client-leg trust guard",
    );
  }
  assertAbsentUnsafeFields(feeTransaction);
  assertAbsentUnsafeFields(paymentTransaction);
  return transactions;
}

async function buildExactPaymentHeader(input: {
  readonly paymentRequired: PaymentRequired;
  readonly requirement: PaymentRequirements;
  readonly signer: Signer;
  readonly algodUrl?: string;
}): Promise<string> {
  const avmSigner = {
    address: input.signer.address,
    signTransactions: async (
      txns: Uint8Array[],
      indexesToSign?: number[],
    ): Promise<(Uint8Array | null)[]> => {
      const transactions = guardExactGroup({
        txns,
        indexesToSign,
        requirement: input.requirement,
        signerAddress: input.signer.address,
      });
      return transactions.map((transaction, index) =>
        index === 1
          ? input.signer.sign(algosdk.encodeUnsignedTransaction(transaction))
          : null,
      );
    },
  };
  const scheme = new ExactAvmScheme(avmSigner, {
    ...(input.algodUrl === undefined ? {} : { algodUrl: input.algodUrl }),
  });
  const result = await scheme.createPaymentPayload(
    2,
    input.requirement as X402PaymentRequirements,
  );
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: input.paymentRequired.resource,
    accepted: input.requirement as X402PaymentRequirements,
    payload: result.payload,
    extensions: input.paymentRequired.extensions,
  };
  return encodePaymentSignatureHeader(payload);
}

export async function buildPaymentHeader(input: {
  readonly paymentRequired: PaymentRequired;
  readonly requirement: PaymentRequirements;
  readonly signer: Signer;
  readonly algodUrl?: string;
  readonly nonce?: () => string;
}): Promise<string> {
  if (input.requirement.scheme === "exact") {
    return buildExactPaymentHeader(input);
  }
  const payload = {
    x402Version: 2,
    resource: input.paymentRequired.resource,
    accepted: input.requirement,
    extensions: input.paymentRequired.extensions,
    payload: {
      from: input.signer.address,
      amountMicroUsdc: Number(input.requirement.amount),
      asset: input.requirement.asset,
      payTo: input.requirement.payTo,
      nonce: (input.nonce ?? randomUUID)(),
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export type CachedPayment = {
  readonly claimId: string;
  readonly headerBytes: string;
  readonly amountMicroUsdc: number;
};

export class PaymentCache {
  readonly #payments = new Map<string, CachedPayment>();

  get(claimId: string): CachedPayment | undefined {
    return this.#payments.get(claimId);
  }

  set(payment: CachedPayment): void {
    this.#payments.set(payment.claimId, payment);
  }

  delete(claimId: string): void {
    this.#payments.delete(claimId);
  }
}
