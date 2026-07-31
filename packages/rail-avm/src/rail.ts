import type {
  FundingInstruction,
  PaymentChallenge,
  PaymentRail,
  PaymentRequired,
  PayoutInstruction,
  PreparedFunding,
  PreparedPayouts,
  PreparedSubmission,
  SendResult,
  SettleResult,
  SignedSubmitResult,
  StakeQuote,
  TxStatus,
  VerifyResult,
} from "@onestepchess/core";
import { RailError } from "@onestepchess/core";
import algosdk from "algosdk";
import { z } from "zod";
import {
  decodePayment,
  decodeTransactionB64,
  parsePaymentHeader,
} from "./decode.js";
import { mapSettleFailure, mapVerifyFailure } from "./taxonomy.js";

const DEFAULT_MAX_TIMEOUT_SECONDS = 120;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAYOUT_BATCH = 16;
const MAX_VALIDITY_WINDOW = 1_000;
const MAX_NOTE_BYTES = 1_024;
const TRANSACTION_FEE = 1_000;

const caip2Schema = z
  .string()
  .regex(/^algorand:[A-Za-z0-9+/]{43}=$/)
  .refine((value) => {
    const encoded = value.slice("algorand:".length);
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length === 32 && bytes.toString("base64") === encoded;
  });

const httpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
});

const configSchema = z
  .object({
    caip2: caip2Schema,
    usdcAsaId: z.number().int().positive().safe(),
    algodUrl: httpUrlSchema,
    indexerUrl: httpUrlSchema,
    facilitatorUrl: httpUrlSchema,
    treasuryMnemonic: z.string().min(1),
    maxTimeoutSeconds: z.number().int().positive().safe().optional(),
    requestTimeoutMs: z.number().int().positive().safe().optional(),
  })
  .strict();

const supportedSchema = z.object({
  kinds: z.array(
    z.object({
      x402Version: z.number().int(),
      scheme: z.string(),
      network: z.string(),
      extra: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  extensions: z.array(z.string()).optional(),
  signers: z.record(z.string(), z.array(z.string())),
});

const verifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  invalidMessage: z.string().optional(),
});

const settleResponseSchema = z.object({
  success: z.boolean(),
  transaction: z.string().optional(),
  network: z.string().optional(),
  confirmedRound: z.number().int().positive().safe().optional(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
});

const suggestedParamsSchema = z.object({
  fee: z.number().int().nonnegative().safe(),
  "min-fee": z.number().int().positive().safe(),
  "last-round": z.number().int().nonnegative().safe(),
  "genesis-id": z.string().min(1),
  "genesis-hash": z.string().min(1),
});

const pendingSchema = z.object({
  "confirmed-round": z.number().int().nonnegative().safe().optional(),
  "pool-error": z.string().optional(),
});

const indexedStatusSchema = z.object({
  transaction: z.object({
    id: z.string().min(1),
    "confirmed-round": z.number().int().positive().safe(),
  }),
});

const indexedNoteTransactionSchema = z.object({
  id: z.string().min(1),
  sender: z.string(),
  "confirmed-round": z.number().int().positive().safe(),
  note: z.string().optional(),
});

const statusSchema = z.object({
  "last-round": z.number().int().nonnegative().safe(),
});

const noteSearchSchema = z.object({
  transactions: z.array(indexedNoteTransactionSchema),
});

const accountSchema = z.object({
  amount: z.number().int().nonnegative().safe(),
  "min-balance": z.number().int().nonnegative().safe(),
  "auth-addr": z.string().optional(),
  assets: z
    .array(
      z.object({
        "asset-id": z.number().int().positive().safe(),
        amount: z.number().int().nonnegative().safe(),
      }),
    )
    .optional(),
});

const submitResponseSchema = z.object({ txId: z.string().min(1) });

const preparedSubmissionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("payouts"),
    payloadB64: z.string().min(1),
    groupId: z.string().min(1),
    txids: z
      .array(
        z.object({
          jobId: z.string().min(1),
          txid: z.string().min(1),
        }),
      )
      .min(1)
      .max(MAX_PAYOUT_BATCH),
    lastValidRound: z.number().int().positive().safe(),
  }),
  z.object({
    kind: z.literal("funding"),
    payloadB64: z.string().min(1),
    player: z.string().min(1),
    leg: z.enum(["algo", "usdc"]),
    txid: z.string().min(1),
    lastValidRound: z.number().int().positive().safe(),
  }),
]);

export type AvmRailConfig = z.input<typeof configSchema>;

export type AvmRailDependencies = {
  readonly fetch?: typeof globalThis.fetch;
};

type PublicConfig = Omit<z.output<typeof configSchema>, "treasuryMnemonic"> & {
  readonly maxTimeoutSeconds: number;
  readonly requestTimeoutMs: number;
};

type AccountResponse = z.infer<typeof accountSchema>;

function contract(message: string): RailError {
  return new RailError("CONTRACT", message);
}

function unavailable(message: string): RailError {
  return new RailError("UNAVAILABLE", message);
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function canonicalBase64(value: string): Buffer | null {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.toString("base64") === value ? bytes : null;
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function isPositiveSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isValidNote(value: string): boolean {
  const length = Buffer.byteLength(value, "utf8");
  return length > 0 && length <= MAX_NOTE_BYTES;
}

function sameOptionalString(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right;
}

function sameRequirement(
  accepted: PaymentRequired["accepts"][0],
  required: PaymentRequired["accepts"][0],
): boolean {
  const acceptedKeys = Object.keys(accepted.extra).sort();
  const requiredKeys = Object.keys(required.extra).sort();
  return (
    accepted.scheme === required.scheme &&
    accepted.network === required.network &&
    accepted.asset === required.asset &&
    accepted.amount === required.amount &&
    accepted.payTo === required.payTo &&
    accepted.maxTimeoutSeconds === required.maxTimeoutSeconds &&
    acceptedKeys.length === requiredKeys.length &&
    acceptedKeys.every(
      (key, index) =>
        key === requiredKeys[index] &&
        accepted.extra[key] === required.extra[key],
    )
  );
}

async function parseJson<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const result = schema.safeParse(await response.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function createAvmRail(
  input: AvmRailConfig,
  dependencies: AvmRailDependencies = {},
): PaymentRail {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw contract("Invalid AVM rail configuration");
  const { treasuryMnemonic, ...configured } = parsed.data;
  let treasuryAddress: string;
  let secretKey: Uint8Array;
  try {
    const account = algosdk.mnemonicToSecretKey(treasuryMnemonic);
    treasuryAddress = account.addr.toString();
    secretKey = account.sk;
  } catch {
    throw contract("Invalid treasury signing key");
  }
  const config: PublicConfig = Object.freeze({
    ...configured,
    algodUrl: configured.algodUrl.replace(/\/+$/, ""),
    indexerUrl: configured.indexerUrl.replace(/\/+$/, ""),
    facilitatorUrl: configured.facilitatorUrl.replace(/\/+$/, ""),
    maxTimeoutSeconds:
      configured.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    requestTimeoutMs: configured.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  let feePayer: string | undefined;

  function redactDetail(value: string): string {
    return value.split(treasuryMnemonic).join("[REDACTED]");
  }

  async function request(url: string, init?: RequestInit): Promise<Response> {
    return fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  }

  async function responseDetail(
    response: Response,
  ): Promise<string | undefined> {
    try {
      const value = (await response.text()).slice(0, 500).trim();
      return value.length === 0 ? undefined : redactDetail(value);
    } catch {
      return undefined;
    }
  }

  function localPaymentPayload(
    header: string,
    required: PaymentRequired,
  ): ReturnType<typeof parsePaymentHeader> {
    const payload = parsePaymentHeader(header);
    const requirement = required.accepts[0];
    if (
      payload === null ||
      requirement === undefined ||
      required.x402Version !== 2 ||
      required.accepts.length !== 1 ||
      requirement.scheme !== "exact" ||
      requirement.network !== config.caip2 ||
      requirement.asset !== String(config.usdcAsaId) ||
      requirement.payTo !== treasuryAddress ||
      requirement.extra.feePayer !== feePayer ||
      requirement.extra.decimals !== 6 ||
      payload.x402Version !== required.x402Version ||
      payload.resource.url !== required.resource.url ||
      !sameOptionalString(
        payload.resource.description,
        required.resource.description,
      ) ||
      !sameOptionalString(
        payload.resource.mimeType,
        required.resource.mimeType,
      ) ||
      !sameRequirement(payload.accepted, requirement) ||
      payload.payload.paymentGroup.length !== 2 ||
      payload.payload.paymentIndex !== 1
    ) {
      return null;
    }
    const decoded = decodePayment(header);
    const feeTransaction = decodeTransactionB64(
      payload.payload.paymentGroup[0] ?? "",
    );
    const paymentTransaction = decodeTransactionB64(
      payload.payload.paymentGroup[1] ?? "",
    );
    const expectedFeePayer = requirement.extra.feePayer;
    if (
      !decoded.ok ||
      typeof expectedFeePayer !== "string" ||
      !algosdk.isValidAddress(expectedFeePayer) ||
      decoded.payment.asset !== requirement.asset ||
      String(decoded.payment.amountMicroUsdc) !== requirement.amount ||
      decoded.payment.payTo !== requirement.payTo ||
      feeTransaction === null ||
      paymentTransaction === null ||
      feeTransaction.payment === undefined ||
      feeTransaction.sender.toString() !== expectedFeePayer ||
      feeTransaction.payment.receiver.toString() !== expectedFeePayer ||
      feeTransaction.payment.amount !== 0n ||
      feeTransaction.group === undefined ||
      paymentTransaction.group === undefined ||
      !Buffer.from(feeTransaction.group).equals(
        Buffer.from(paymentTransaction.group),
      )
    ) {
      return null;
    }
    return payload;
  }

  async function health(): Promise<boolean> {
    try {
      const response = await request(
        endpoint(config.facilitatorUrl, "/supported"),
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) return false;
      const result = await parseJson(response, supportedSchema);
      if (result === null) return false;
      const kind = result.kinds.find(
        (item) =>
          item.x402Version === 2 &&
          item.scheme === "exact" &&
          item.network === config.caip2,
      );
      const candidate = kind?.extra?.feePayer;
      if (typeof candidate !== "string" || !algosdk.isValidAddress(candidate)) {
        return false;
      }
      const applicableSigners = [
        ...(result.signers[config.caip2] ?? []),
        ...(result.signers["algorand:*"] ?? []),
      ];
      if (!applicableSigners.includes(candidate)) return false;
      feePayer = candidate;
      return true;
    } catch {
      return false;
    }
  }

  function buildPaymentChallenge(quote: StakeQuote): PaymentChallenge {
    if (!isPositiveSafe(quote.amountMicroUsdc)) {
      throw contract("Stake amount must be a positive safe integer");
    }
    try {
      const resource = new URL(quote.resource);
      if (resource.protocol !== "https:" && resource.protocol !== "http:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw contract("Payment resource must be an absolute HTTP URL");
    }
    if (feePayer === undefined) {
      throw new RailError(
        "NOT_READY",
        "AVM payment requirements need a successful health probe",
      );
    }
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: quote.resource },
      accepts: [
        {
          scheme: "exact",
          network: config.caip2,
          asset: String(config.usdcAsaId),
          amount: String(quote.amountMicroUsdc),
          payTo: treasuryAddress,
          maxTimeoutSeconds: config.maxTimeoutSeconds,
          extra: { feePayer, decimals: 6 },
        },
      ],
    };
    return { required, header: base64Json(required) };
  }

  async function verify(
    header: string,
    required: PaymentRequired,
  ): Promise<VerifyResult> {
    const paymentPayload = localPaymentPayload(header, required);
    if (paymentPayload === null) {
      return { ok: false, reason: "invalid_payment" };
    }
    try {
      const response = await request(
        endpoint(config.facilitatorUrl, "/verify"),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            x402Version: 2,
            paymentPayload,
            paymentRequirements: required.accepts[0],
          }),
        },
      );
      if (response.status >= 500) return { ok: false, reason: "unavailable" };
      const result = await parseJson(response, verifyResponseSchema);
      if (result === null) return { ok: false, reason: "unavailable" };
      if (result.isValid) return { ok: true };
      const upstreamDetail = result.invalidReason ?? result.invalidMessage;
      const detail =
        upstreamDetail === undefined ? undefined : redactDetail(upstreamDetail);
      return {
        ok: false,
        reason: mapVerifyFailure(detail ?? "invalid payment"),
        ...(detail === undefined ? {} : { detail }),
      };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  function encodePaymentResponse(txid: string): string {
    return base64Json({
      success: true,
      transaction: txid,
      network: config.caip2,
    });
  }

  async function settle(
    header: string,
    required: PaymentRequired,
  ): Promise<SettleResult> {
    const paymentPayload = localPaymentPayload(header, required);
    if (paymentPayload === null) {
      return { ok: false, reason: "rejected", detail: "invalid payment" };
    }
    try {
      const response = await request(
        endpoint(config.facilitatorUrl, "/settle"),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            x402Version: 2,
            paymentPayload,
            paymentRequirements: required.accepts[0],
          }),
        },
      );
      if (response.status >= 500) return { ok: false, reason: "unavailable" };
      const result = await parseJson(response, settleResponseSchema);
      if (result === null) return { ok: false, reason: "unavailable" };
      if (
        result.success &&
        result.transaction !== undefined &&
        result.transaction.length > 0 &&
        result.network === config.caip2
      ) {
        return {
          ok: true,
          txid: result.transaction,
          confirmedRound: result.confirmedRound ?? null,
          paymentResponseHeader: encodePaymentResponse(result.transaction),
        };
      }
      if (result.success) return { ok: false, reason: "unavailable" };
      const upstreamDetail = result.errorReason ?? result.errorMessage;
      const detail =
        upstreamDetail === undefined ? undefined : redactDetail(upstreamDetail);
      return {
        ok: false,
        reason: mapSettleFailure(detail ?? "rejected"),
        ...(detail === undefined ? {} : { detail }),
      };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  async function loadSuggestedParams(): Promise<algosdk.SuggestedParams> {
    try {
      const response = await request(
        endpoint(config.algodUrl, "/v2/transactions/params"),
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) throw unavailable("Algod suggested params unavailable");
      const result = await parseJson(response, suggestedParamsSchema);
      if (result === null)
        throw unavailable("Algod suggested params malformed");
      const firstValid = result["last-round"];
      if (firstValid > Number.MAX_SAFE_INTEGER - MAX_VALIDITY_WINDOW) {
        throw unavailable("Algod suggested validity window is unsafe");
      }
      const lastValid = firstValid + MAX_VALIDITY_WINDOW;
      const genesisHash = result["genesis-hash"];
      const genesisBytes = canonicalBase64(genesisHash);
      if (
        genesisHash !== config.caip2.slice("algorand:".length) ||
        genesisBytes === null ||
        genesisBytes.length !== 32 ||
        lastValid < firstValid ||
        lastValid > firstValid + MAX_VALIDITY_WINDOW ||
        result["min-fee"] > TRANSACTION_FEE
      ) {
        throw unavailable(
          "Algod suggested params do not match configured network or bounds",
        );
      }
      return {
        flatFee: true,
        fee: TRANSACTION_FEE,
        minFee: result["min-fee"],
        firstValid,
        lastValid,
        genesisID: result["genesis-id"],
        genesisHash: genesisBytes,
      };
    } catch (error) {
      if (error instanceof RailError) throw error;
      throw unavailable("Algod suggested params unavailable");
    }
  }

  function signTreasury(transaction: algosdk.Transaction): Uint8Array {
    return transaction.signTxn(secretKey);
  }

  async function preparePayouts(
    batch: readonly PayoutInstruction[],
  ): Promise<PreparedPayouts> {
    if (batch.length === 0 || batch.length > MAX_PAYOUT_BATCH) {
      throw contract("Payout batch size must be between 1 and 16");
    }
    const jobIds = new Set<string>();
    for (const item of batch) {
      const note = `osc:payout:${item.jobId}`;
      if (
        !isValidNote(note) ||
        jobIds.has(item.jobId) ||
        !isPositiveSafe(item.amountMicroUsdc) ||
        !algosdk.isValidAddress(item.recipient)
      ) {
        throw contract("Invalid payout instruction");
      }
      jobIds.add(item.jobId);
    }
    const suggestedParams = await loadSuggestedParams();
    const transactions = batch.map((item, index) =>
      algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: treasuryAddress,
        receiver: item.recipient,
        amount: item.amountMicroUsdc,
        assetIndex: config.usdcAsaId,
        note: new TextEncoder().encode(`osc:payout:${item.jobId}`),
        suggestedParams: {
          ...suggestedParams,
          flatFee: true,
          fee: index === 0 ? TRANSACTION_FEE * batch.length : 0,
        },
      }),
    );
    algosdk.assignGroupID(transactions);
    const group = transactions[0]?.group;
    if (group === undefined)
      throw unavailable("Could not construct payout group");
    const signed = transactions.map(signTreasury);
    return {
      kind: "payouts",
      payloadB64: Buffer.concat(
        signed.map((bytes) => Buffer.from(bytes)),
      ).toString("base64"),
      groupId: Buffer.from(group).toString("base64"),
      txids: transactions.map((transaction, index) => ({
        jobId: batch[index]?.jobId ?? "",
        txid: transaction.txID(),
      })),
      lastValidRound: Number(transactions[0]?.lastValid),
    };
  }

  async function prepareFunding(
    instruction: FundingInstruction,
  ): Promise<PreparedFunding> {
    const note = `osc:bonus:${instruction.leg}:${instruction.player}`;
    if (
      !algosdk.isValidAddress(instruction.player) ||
      (instruction.leg !== "algo" && instruction.leg !== "usdc") ||
      !isPositiveSafe(instruction.amount) ||
      !isValidNote(note)
    ) {
      throw contract("Invalid funding instruction");
    }
    const suggestedParams = {
      ...(await loadSuggestedParams()),
      flatFee: true,
      fee: TRANSACTION_FEE,
    };
    const common = {
      sender: treasuryAddress,
      receiver: instruction.player,
      amount: instruction.amount,
      note: new TextEncoder().encode(note),
      suggestedParams,
    };
    const transaction =
      instruction.leg === "algo"
        ? algosdk.makePaymentTxnWithSuggestedParamsFromObject(common)
        : algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            ...common,
            assetIndex: config.usdcAsaId,
          });
    return {
      kind: "funding",
      payloadB64: Buffer.from(signTreasury(transaction)).toString("base64"),
      player: instruction.player,
      leg: instruction.leg,
      txid: transaction.txID(),
      lastValidRound: Number(transaction.lastValid),
    };
  }

  function validatePrepared(prepared: PreparedSubmission): Buffer {
    const parsedPrepared = preparedSubmissionSchema.safeParse(prepared);
    if (!parsedPrepared.success)
      throw contract("Prepared payload is malformed");
    const payload = canonicalBase64(parsedPrepared.data.payloadB64);
    if (payload === null) throw contract("Prepared payload is malformed");
    if (parsedPrepared.data.kind === "payouts") {
      const group = canonicalBase64(parsedPrepared.data.groupId);
      const jobIds = new Set(
        parsedPrepared.data.txids.map(({ jobId }) => jobId),
      );
      const txids = new Set(parsedPrepared.data.txids.map(({ txid }) => txid));
      if (
        group === null ||
        group.length !== 32 ||
        jobIds.size !== parsedPrepared.data.txids.length ||
        txids.size !== parsedPrepared.data.txids.length
      ) {
        throw contract("Prepared payout metadata is malformed");
      }
      return payload;
    }
    if (!algosdk.isValidAddress(parsedPrepared.data.player)) {
      throw contract("Prepared funding metadata is malformed");
    }
    try {
      const signed = algosdk.decodeSignedTransaction(payload);
      const transaction = signed.txn;
      const expectedNote = `osc:bonus:${parsedPrepared.data.leg}:${parsedPrepared.data.player}`;
      const correctTransfer =
        parsedPrepared.data.leg === "algo"
          ? transaction.payment?.receiver.toString() ===
            parsedPrepared.data.player
          : transaction.assetTransfer?.receiver.toString() ===
              parsedPrepared.data.player &&
            transaction.assetTransfer.assetIndex === BigInt(config.usdcAsaId);
      if (
        (signed.sig === undefined &&
          signed.msig === undefined &&
          signed.lsig === undefined) ||
        transaction.txID() !== parsedPrepared.data.txid ||
        transaction.sender.toString() !== treasuryAddress ||
        Number(transaction.lastValid) !== parsedPrepared.data.lastValidRound ||
        Buffer.from(transaction.note).toString("utf8") !== expectedNote ||
        !correctTransfer
      ) {
        throw new Error("metadata mismatch");
      }
    } catch {
      throw contract("Prepared funding payload is malformed");
    }
    return payload;
  }

  async function submitPrepared(
    prepared: PreparedSubmission,
  ): Promise<SendResult> {
    const payload = validatePrepared(prepared);
    try {
      const response = await request(
        endpoint(config.algodUrl, "/v2/transactions"),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-binary",
          },
          body: payload,
        },
      );
      if (response.ok) return { ok: true };
      if (response.status >= 500) return { ok: false, reason: "unavailable" };
      const detail = await responseDetail(response);
      return {
        ok: false,
        reason: "rejected",
        ...(detail === undefined ? {} : { detail }),
      };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  async function getJsonResponse(url: string): Promise<Response> {
    try {
      return await request(url, { headers: { accept: "application/json" } });
    } catch {
      throw unavailable("Chain query unavailable");
    }
  }

  async function getTransactionStatus(txid: string): Promise<TxStatus> {
    const pending = await getJsonResponse(
      endpoint(
        config.algodUrl,
        `/v2/transactions/pending/${encodeURIComponent(txid)}`,
      ),
    );
    if (pending.ok) {
      const result = await parseJson(pending, pendingSchema);
      if (result === null)
        throw unavailable("Algod pending response malformed");
      const confirmedRound = result["confirmed-round"] ?? 0;
      return confirmedRound > 0
        ? { status: "confirmed", confirmedRound }
        : { status: "pending" };
    }
    if (pending.status !== 404) throw unavailable("Algod pending query failed");

    const indexed = await getJsonResponse(
      endpoint(
        config.indexerUrl,
        `/v2/transactions/${encodeURIComponent(txid)}`,
      ),
    );
    if (indexed.ok) {
      const result = await parseJson(indexed, indexedStatusSchema);
      if (result === null) {
        throw unavailable("Indexer transaction response malformed");
      }
      return {
        status: "confirmed",
        confirmedRound: result.transaction["confirmed-round"],
      };
    }
    if (indexed.status !== 404) {
      throw unavailable("Indexer transaction query failed");
    }

    const status = await getJsonResponse(
      endpoint(config.algodUrl, "/v2/status"),
    );
    if (!status.ok) throw unavailable("Algod status query failed");
    const result = await parseJson(status, statusSchema);
    if (result === null) throw unavailable("Algod status response malformed");
    return { status: "not_found", currentRound: result["last-round"] };
  }

  async function findByNote(note: string): Promise<{
    readonly txid: string;
    readonly confirmedRound: number;
  } | null> {
    const expectedNote = Buffer.from(note, "utf8").toString("base64");
    const url = new URL(endpoint(config.indexerUrl, "/v2/transactions"));
    url.searchParams.set("address", treasuryAddress);
    url.searchParams.set("address-role", "sender");
    url.searchParams.set("note-prefix", expectedNote);
    const response = await getJsonResponse(url.toString());
    if (!response.ok) throw unavailable("Indexer note query failed");
    const result = await parseJson(response, noteSearchSchema);
    if (result === null) throw unavailable("Indexer note response malformed");
    const match = result.transactions
      .filter(
        (item) => item.sender === treasuryAddress && item.note === expectedNote,
      )
      .sort(
        (left, right) =>
          left["confirmed-round"] - right["confirmed-round"] ||
          left.id.localeCompare(right.id),
      )[0];
    return match === undefined
      ? null
      : { txid: match.id, confirmedRound: match["confirmed-round"] };
  }

  async function findPayoutByNote(jobId: string): Promise<{
    readonly txid: string;
    readonly confirmedRound: number;
  } | null> {
    const note = `osc:payout:${jobId}`;
    if (!isValidNote(note)) throw contract("Invalid payout job id");
    return findByNote(note);
  }

  async function findFundingByNote(
    player: string,
    leg: "algo" | "usdc",
  ): Promise<{
    readonly txid: string;
    readonly confirmedRound: number;
  } | null> {
    if (!algosdk.isValidAddress(player) || (leg !== "algo" && leg !== "usdc")) {
      throw contract("Invalid funding note query");
    }
    return findByNote(`osc:bonus:${leg}:${player}`);
  }

  function assertAddress(address: string): void {
    if (!algosdk.isValidAddress(address)) {
      throw contract("Invalid Algorand address");
    }
  }

  async function loadAccount(address: string): Promise<AccountResponse | null> {
    assertAddress(address);
    const response = await getJsonResponse(
      endpoint(config.algodUrl, `/v2/accounts/${encodeURIComponent(address)}`),
    );
    if (response.status === 404) return null;
    if (!response.ok) throw unavailable("Algod account query failed");
    const result = await parseJson(response, accountSchema);
    if (result === null) throw unavailable("Algod account response malformed");
    return result;
  }

  async function getBalances(address: string): Promise<{
    readonly usdcMicroUsdc: number;
    readonly algoMicroAlgo: number;
  }> {
    const account = await loadAccount(address);
    if (account === null) return { usdcMicroUsdc: 0, algoMicroAlgo: 0 };
    const holding = account.assets?.find(
      (asset) => asset["asset-id"] === config.usdcAsaId,
    );
    return {
      usdcMicroUsdc: holding?.amount ?? 0,
      algoMicroAlgo: account.amount,
    };
  }

  async function getAccountInfo(address: string): Promise<{
    readonly exists: boolean;
    readonly rekeyed: boolean;
    readonly optedInUsdc: boolean;
    readonly spendableAlgoMicro: number;
  }> {
    const account = await loadAccount(address);
    if (account === null) {
      return {
        exists: false,
        rekeyed: false,
        optedInUsdc: false,
        spendableAlgoMicro: 0,
      };
    }
    return {
      exists: true,
      rekeyed: account["auth-addr"] !== undefined,
      optedInUsdc:
        account.assets?.some(
          (asset) => asset["asset-id"] === config.usdcAsaId,
        ) ?? false,
      spendableAlgoMicro: Math.max(account.amount - account["min-balance"], 0),
    };
  }

  async function buildOptInTxn(address: string): Promise<string> {
    assertAddress(address);
    const transaction =
      algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: address,
        receiver: address,
        amount: 0,
        assetIndex: config.usdcAsaId,
        suggestedParams: {
          ...(await loadSuggestedParams()),
          flatFee: true,
          fee: TRANSACTION_FEE,
        },
      });
    return Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
      "base64",
    );
  }

  async function submitSignedTransaction(
    signedTxnB64: string,
  ): Promise<SignedSubmitResult> {
    const payload = canonicalBase64(signedTxnB64);
    if (payload === null) throw contract("Signed transaction is malformed");
    try {
      const signed = algosdk.decodeSignedTransaction(payload);
      if (
        signed.sig === undefined &&
        signed.msig === undefined &&
        signed.lsig === undefined
      ) {
        throw new Error("unsigned transaction");
      }
    } catch {
      throw contract("Signed transaction is malformed");
    }
    try {
      const response = await request(
        endpoint(config.algodUrl, "/v2/transactions"),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-binary",
          },
          body: payload,
        },
      );
      if (response.status >= 500) return { ok: false, reason: "unavailable" };
      if (response.ok) {
        const result = await parseJson(response, submitResponseSchema);
        return result === null
          ? { ok: false, reason: "unavailable" }
          : { ok: true, txid: result.txId };
      }
      const detail = await responseDetail(response);
      return {
        ok: false,
        reason: "rejected",
        ...(detail === undefined ? {} : { detail }),
      };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  return Object.freeze({
    treasuryAddress,
    buildPaymentChallenge,
    decodePayment,
    verify,
    settle,
    encodePaymentResponse,
    preparePayouts,
    prepareFunding,
    submitPrepared,
    getTransactionStatus,
    findPayoutByNote,
    findFundingByNote,
    buildOptInTxn,
    submitSignedTransaction,
    getBalances,
    getAccountInfo,
    health,
  });
}
