import type {
  PaymentChallenge,
  PaymentRail,
  PaymentRequired,
  PayoutInstruction,
  PreparedPayouts,
  PreparedSubmission,
  SendResult,
  SettleResult,
  StakeQuote,
  TxStatus,
  VerifyResult,
} from "@onestepchess/core";
import { RailError } from "@onestepchess/core";
import algosdk from "algosdk";
import { z } from "zod";
import { decodePayment, parsePaymentHeader } from "./decode.js";
import { mapSettleFailure, mapVerifyFailure } from "./taxonomy.js";

const DEFAULT_MAX_TIMEOUT_SECONDS = 120;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAYOUT_BATCH = 16;
const PAYOUT_FEE = 1_000;

const configSchema = z.object({
  caip2: z.string().regex(/^algorand:[A-Za-z0-9+/]{43}=$/),
  usdcAsaId: z.number().int().positive().safe(),
  algodUrl: z.url(),
  indexerUrl: z.url(),
  facilitatorUrl: z.url(),
  treasuryMnemonic: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive().safe().optional(),
  requestTimeoutMs: z.number().int().positive().safe().optional(),
});

const supportedSchema = z.object({
  kinds: z.array(
    z.object({
      x402Version: z.number(),
      scheme: z.string(),
      network: z.string(),
      extra: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  extensions: z.array(z.string()).optional(),
  signers: z.record(z.string(), z.array(z.string())).optional(),
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
  confirmedRound: z.number().int().positive().optional(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
});

const suggestedParamsSchema = z.object({
  fee: z.number().int().nonnegative(),
  "min-fee": z.number().int().positive(),
  "last-round": z.number().int().nonnegative(),
  "genesis-id": z.string(),
  "genesis-hash": z.string(),
});

const pendingSchema = z.object({
  "confirmed-round": z.number().int().nonnegative().optional(),
  "pool-error": z.string().optional(),
});

const indexedTransactionSchema = z.object({
  id: z.string(),
  "confirmed-round": z.number().int().positive(),
  note: z.string().optional(),
});

const indexedLookupSchema = z.object({ transaction: indexedTransactionSchema });
const statusSchema = z.object({ "last-round": z.number().int().nonnegative() });
const noteSearchSchema = z.object({
  transactions: z.array(indexedTransactionSchema),
});

export type AvmRailConfig = z.input<typeof configSchema>;

export type AvmRailDependencies = {
  readonly fetch?: typeof globalThis.fetch;
};

export type T1AvmRail = Pick<
  PaymentRail,
  | "treasuryAddress"
  | "buildPaymentChallenge"
  | "decodePayment"
  | "verify"
  | "settle"
  | "encodePaymentResponse"
  | "preparePayouts"
  | "submitPrepared"
  | "getTransactionStatus"
  | "findPayoutByNote"
  | "health"
>;

type PublicConfig = Omit<z.output<typeof configSchema>, "treasuryMnemonic"> & {
  readonly maxTimeoutSeconds: number;
  readonly requestTimeoutMs: number;
};

function contract(message: string): RailError {
  return new RailError("CONTRACT", message);
}

function unavailable(message: string): RailError {
  return new RailError("UNAVAILABLE", message);
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

function isPositiveSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function exactRequirementMatches(
  header: string,
  required: PaymentRequired,
): ReturnType<typeof parsePaymentHeader> {
  const payload = parsePaymentHeader(header);
  const requirement = required.accepts[0];
  if (
    payload === null ||
    requirement === undefined ||
    required.accepts.length !== 1 ||
    payload.x402Version !== required.x402Version ||
    payload.accepted.scheme !== requirement.scheme ||
    payload.accepted.network !== requirement.network
  ) {
    return null;
  }
  return payload;
}

async function responseDetail(response: Response): Promise<string | undefined> {
  const value = (await response.text()).slice(0, 500).trim();
  return value.length === 0 ? undefined : value;
}

export function createAvmRail(
  input: AvmRailConfig,
  dependencies: AvmRailDependencies = {},
): T1AvmRail {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw contract("Invalid AVM rail configuration");
  const { treasuryMnemonic, ...configured } = parsed.data;
  let treasury: algosdk.Account;
  try {
    treasury = algosdk.mnemonicToSecretKey(treasuryMnemonic);
  } catch {
    throw contract("Invalid treasury signing key");
  }
  const config: PublicConfig = Object.freeze({
    ...configured,
    maxTimeoutSeconds:
      configured.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    requestTimeoutMs: configured.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const treasuryAddress = treasury.addr.toString();
  const secretKey = treasury.sk;
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

  async function health(): Promise<boolean> {
    try {
      const response = await request(
        endpoint(config.facilitatorUrl, "/supported"),
        {
          headers: { accept: "application/json" },
        },
      );
      if (!response.ok) return false;
      const result = supportedSchema.safeParse(await response.json());
      if (!result.success) return false;
      const kind = result.data.kinds.find(
        (item) =>
          item.x402Version === 2 &&
          item.scheme === "exact" &&
          item.network === config.caip2,
      );
      if (kind === undefined) return false;
      const candidate = kind?.extra?.feePayer;
      const signer =
        typeof candidate === "string"
          ? candidate
          : result.data.signers?.[config.caip2]?.[0];
      if (signer === undefined || !algosdk.isValidAddress(signer)) return false;
      feePayer = signer;
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
      new URL(quote.resource);
    } catch {
      throw contract("Payment resource must be an absolute URL");
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
    const paymentPayload = exactRequirementMatches(header, required);
    if (paymentPayload === null || !decodePayment(header).ok) {
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
      const result = verifyResponseSchema.safeParse(await response.json());
      if (!result.success) return { ok: false, reason: "unavailable" };
      if (result.data.isValid) return { ok: true };
      const upstreamDetail =
        result.data.invalidReason ?? result.data.invalidMessage;
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
    const paymentPayload = exactRequirementMatches(header, required);
    if (paymentPayload === null || !decodePayment(header).ok) {
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
      const result = settleResponseSchema.safeParse(await response.json());
      if (!result.success) return { ok: false, reason: "unavailable" };
      if (
        result.data.success &&
        result.data.transaction !== undefined &&
        result.data.network === config.caip2
      ) {
        return {
          ok: true,
          txid: result.data.transaction,
          confirmedRound: result.data.confirmedRound ?? null,
          paymentResponseHeader: encodePaymentResponse(result.data.transaction),
        };
      }
      const upstreamDetail =
        result.data.errorReason ?? result.data.errorMessage;
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
        {
          headers: { accept: "application/json" },
        },
      );
      if (!response.ok) throw unavailable("Algod suggested params unavailable");
      const result = suggestedParamsSchema.safeParse(await response.json());
      if (!result.success)
        throw unavailable("Algod suggested params malformed");
      const firstValid = result.data["last-round"];
      const lastValid = firstValid + 1_000;
      if (
        result.data["genesis-hash"] !==
          config.caip2.slice("algorand:".length) ||
        lastValid < firstValid ||
        lastValid > firstValid + 1_000
      ) {
        throw unavailable(
          "Algod suggested params do not match configured network",
        );
      }
      return {
        flatFee: true,
        fee: result.data.fee,
        minFee: result.data["min-fee"],
        firstValid,
        lastValid,
        genesisID: result.data["genesis-id"],
        genesisHash: Buffer.from(result.data["genesis-hash"], "base64"),
      };
    } catch (error) {
      if (error instanceof RailError) throw error;
      throw unavailable("Algod suggested params unavailable");
    }
  }

  async function preparePayouts(
    batch: readonly PayoutInstruction[],
  ): Promise<PreparedPayouts> {
    if (batch.length === 0 || batch.length > MAX_PAYOUT_BATCH) {
      throw contract("Payout batch size must be between 1 and 16");
    }
    const jobIds = new Set<string>();
    for (const item of batch) {
      if (
        item.jobId.length === 0 ||
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
          fee: index === 0 ? PAYOUT_FEE * batch.length : 0,
        },
      }),
    );
    algosdk.assignGroupID(transactions);
    const group = transactions[0]?.group;
    if (group === undefined)
      throw unavailable("Could not construct payout group");
    const signed = transactions.map((transaction) =>
      transaction.signTxn(secretKey),
    );
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

  async function submitPrepared(
    prepared: PreparedSubmission,
  ): Promise<SendResult> {
    if (prepared.kind !== "payouts") {
      throw contract("T1 accepts prepared payout groups only");
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(prepared.payloadB64, "base64");
      if (
        payload.length === 0 ||
        payload.toString("base64") !== prepared.payloadB64
      ) {
        throw new Error("bad base64");
      }
    } catch {
      throw contract("Prepared payout payload is malformed");
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
      if (response.ok) return { ok: true };
      if (response.status >= 500) return { ok: false, reason: "unavailable" };
      const upstreamDetail = await responseDetail(response);
      const detail =
        upstreamDetail === undefined ? undefined : redactDetail(upstreamDetail);
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
      let result: ReturnType<typeof pendingSchema.safeParse>;
      try {
        result = pendingSchema.safeParse(await pending.json());
      } catch {
        throw unavailable("Algod pending response malformed");
      }
      if (!result.success)
        throw unavailable("Algod pending response malformed");
      const confirmedRound = result.data["confirmed-round"] ?? 0;
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
      let result: ReturnType<typeof indexedLookupSchema.safeParse>;
      try {
        result = indexedLookupSchema.safeParse(await indexed.json());
      } catch {
        throw unavailable("Indexer transaction response malformed");
      }
      if (!result.success)
        throw unavailable("Indexer transaction response malformed");
      return {
        status: "confirmed",
        confirmedRound: result.data.transaction["confirmed-round"],
      };
    }
    if (indexed.status !== 404)
      throw unavailable("Indexer transaction query failed");

    const status = await getJsonResponse(
      endpoint(config.algodUrl, "/v2/status"),
    );
    if (!status.ok) throw unavailable("Algod status query failed");
    let result: ReturnType<typeof statusSchema.safeParse>;
    try {
      result = statusSchema.safeParse(await status.json());
    } catch {
      throw unavailable("Algod status response malformed");
    }
    if (!result.success) throw unavailable("Algod status response malformed");
    return { status: "not_found", currentRound: result.data["last-round"] };
  }

  async function findPayoutByNote(jobId: string): Promise<{
    readonly txid: string;
    readonly confirmedRound: number;
  } | null> {
    if (jobId.length === 0) throw contract("Payout job id must not be empty");
    const expectedNote = Buffer.from(`osc:payout:${jobId}`, "utf8").toString(
      "base64",
    );
    const url = new URL(endpoint(config.indexerUrl, "/v2/transactions"));
    url.searchParams.set("address", treasuryAddress);
    url.searchParams.set("address-role", "sender");
    url.searchParams.set("note-prefix", expectedNote);
    const response = await getJsonResponse(url.toString());
    if (!response.ok) throw unavailable("Indexer note query failed");
    let result: ReturnType<typeof noteSearchSchema.safeParse>;
    try {
      result = noteSearchSchema.safeParse(await response.json());
    } catch {
      throw unavailable("Indexer note response malformed");
    }
    if (!result.success) throw unavailable("Indexer note response malformed");
    const match = result.data.transactions
      .filter((item) => item.note === expectedNote)
      .sort(
        (left, right) =>
          left["confirmed-round"] - right["confirmed-round"] ||
          left.id.localeCompare(right.id),
      )[0];
    return match === undefined
      ? null
      : { txid: match.id, confirmedRound: match["confirmed-round"] };
  }

  return Object.freeze({
    treasuryAddress,
    buildPaymentChallenge,
    decodePayment,
    verify,
    settle,
    encodePaymentResponse,
    preparePayouts,
    submitPrepared,
    getTransactionStatus,
    findPayoutByNote,
    health,
  });
}
