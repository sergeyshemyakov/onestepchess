import algosdk from "algosdk";
import { z } from "zod";
import type { Signer } from "./auth.js";
import { OscClientError } from "./errors.js";
import { createKeyfile } from "./keyfile.js";
import type { Meta } from "./schemas.js";
import { assertSupportedNetwork, resolveAlgodUrl } from "./x402.js";

const accountSchema = z.object({
  amount: z.number().int().nonnegative(),
  "min-balance": z.number().int().nonnegative(),
  assets: z.array(
    z.object({
      "asset-id": z.number().int().positive(),
      amount: z.number().int().nonnegative(),
    }),
  ),
});

const paramsSchema = z.object({
  fee: z.number().int().nonnegative(),
  "min-fee": z.number().int().positive(),
  "last-round": z.number().int().nonnegative(),
  "genesis-id": z.string(),
  "genesis-hash": z.string(),
});

const submitSchema = z.object({ txId: z.string() });
const pendingSchema = z.object({
  "confirmed-round": z.number().int().nonnegative().optional(),
  "pool-error": z.string().optional(),
});

export type WalletDependencies = {
  readonly fetch?: typeof globalThis.fetch;
  readonly algodUrl?: string;
  readonly requestTimeoutMs?: number;
};

export type WalletStatus =
  | {
      readonly address: string;
      readonly algoMicroAlgo: number;
      readonly spendableAlgoMicro: number;
      readonly usdcMicroUsdc: number;
      readonly optedInUsdc: boolean;
      readonly ready: boolean;
      readonly missing: "fund_algo" | "optin" | "fund_usdc" | null;
      readonly mock?: false;
    }
  | {
      readonly address: string;
      readonly algoMicroAlgo: 0;
      readonly spendableAlgoMicro: 0;
      readonly usdcMicroUsdc: 0;
      readonly optedInUsdc: true;
      readonly ready: true;
      readonly missing: null;
      readonly mock: true;
    };

function algodBase(meta: Meta, override?: string): string {
  return resolveAlgodUrl(meta, override);
}

async function algodRequest(
  path: string,
  meta: Meta,
  dependencies: WalletDependencies,
  init?: RequestInit,
): Promise<Response> {
  const fetchFn = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    return await fetchFn(`${algodBase(meta, dependencies.algodUrl)}${path}`, {
      ...init,
      signal: AbortSignal.timeout(dependencies.requestTimeoutMs ?? 10_000),
    });
  } catch {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      "the configured algod endpoint is unavailable",
    );
  }
}

async function account(
  signer: Signer,
  meta: Meta,
  dependencies: WalletDependencies,
): Promise<z.infer<typeof accountSchema> | null> {
  const response = await algodRequest(
    `/v2/accounts/${encodeURIComponent(signer.address)}`,
    meta,
    dependencies,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      `algod account lookup failed (${response.status})`,
    );
  }
  try {
    return accountSchema.parse(await response.json());
  } catch {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      "algod returned a malformed account response",
    );
  }
}

export function createWallet(options: { readonly keyfile: string }) {
  return createKeyfile(options.keyfile);
}

export async function walletStatus(
  signer: Signer,
  meta: Meta,
  dependencies: WalletDependencies = {},
): Promise<WalletStatus> {
  const network = assertSupportedNetwork({ meta });
  if (network === "mock") {
    return {
      address: signer.address,
      algoMicroAlgo: 0,
      spendableAlgoMicro: 0,
      usdcMicroUsdc: 0,
      optedInUsdc: true,
      ready: true,
      missing: null,
      mock: true,
    };
  }
  const info = await account(signer, meta, dependencies);
  const algoMicroAlgo = info?.amount ?? 0;
  const spendableAlgoMicro = Math.max(
    0,
    algoMicroAlgo - (info?.["min-balance"] ?? 0),
  );
  const assetId = Number(meta.network.usdcAssetId);
  const holding = info?.assets.find((asset) => asset["asset-id"] === assetId);
  const optedInUsdc = holding !== undefined;
  const usdcMicroUsdc = holding?.amount ?? 0;
  const missing =
    !optedInUsdc && spendableAlgoMicro < 101_000
      ? "fund_algo"
      : !optedInUsdc
        ? "optin"
        : usdcMicroUsdc < meta.economics.agentStakeMicroUsdc
          ? "fund_usdc"
          : null;
  return {
    address: signer.address,
    algoMicroAlgo,
    spendableAlgoMicro,
    usdcMicroUsdc,
    optedInUsdc,
    ready: missing === null,
    missing,
    mock: false,
  };
}

function assertSafeOptIn(input: {
  readonly transaction: algosdk.Transaction;
  readonly signer: Signer;
  readonly meta: Meta;
}): void {
  const transaction = input.transaction;
  const transfer = transaction.assetTransfer;
  const genesis = Buffer.from(
    transaction.genesisHash ?? new Uint8Array(),
  ).toString("base64");
  if (
    transfer === undefined ||
    transaction.sender.toString() !== input.signer.address ||
    transfer.receiver.toString() !== input.signer.address ||
    transfer.amount !== 0n ||
    transfer.assetIndex.toString() !== input.meta.network.usdcAssetId ||
    transaction.fee !== 1_000n ||
    transaction.firstValid > transaction.lastValid ||
    transaction.lastValid - transaction.firstValid > 1_000n ||
    genesis !== input.meta.network.caip2.split(":")[1] ||
    transaction.group !== undefined ||
    (transaction.lease !== undefined && transaction.lease.length > 0) ||
    (transaction.note !== undefined && transaction.note.length > 0) ||
    transaction.rekeyTo !== undefined ||
    transfer.closeRemainderTo !== undefined ||
    transfer.assetSender !== undefined
  ) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "USDC opt-in transaction failed the pre-sign safety guard",
    );
  }
}

export async function optInUsdc(
  signer: Signer,
  meta: Meta,
  dependencies: WalletDependencies = {},
): Promise<
  | { readonly alreadyOptedIn: true; readonly mock?: true }
  | { readonly txid: string }
> {
  const network = assertSupportedNetwork({ meta });
  if (network === "mock") {
    return { alreadyOptedIn: true, mock: true };
  }
  const info = await account(signer, meta, dependencies);
  const assetId = Number(meta.network.usdcAssetId);
  if (info?.assets.some((asset) => asset["asset-id"] === assetId)) {
    return { alreadyOptedIn: true };
  }
  const spendable = Math.max(
    0,
    (info?.amount ?? 0) - (info?.["min-balance"] ?? 0),
  );
  if (spendable < 101_000) {
    const missing = 101_000 - spendable;
    throw new OscClientError(
      "ALGO_SHORTFALL",
      `USDC opt-in needs ${missing} more µALGO`,
      String(missing),
    );
  }

  const paramsResponse = await algodRequest(
    "/v2/transactions/params",
    meta,
    dependencies,
  );
  if (!paramsResponse.ok) {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      "algod suggested params are unavailable",
    );
  }
  let params: z.infer<typeof paramsSchema>;
  try {
    params = paramsSchema.parse(await paramsResponse.json());
  } catch {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      "algod returned malformed suggested params",
    );
  }
  if (params["genesis-hash"] !== meta.network.caip2.split(":")[1]) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "algod suggested params do not match the server network",
    );
  }
  const firstValid = params["last-round"];
  const transaction = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
    {
      sender: signer.address,
      receiver: signer.address,
      amount: 0,
      assetIndex: assetId,
      suggestedParams: {
        flatFee: true,
        fee: 1_000,
        minFee: params["min-fee"],
        firstValid,
        lastValid: firstValid + 1_000,
        genesisID: params["genesis-id"],
        genesisHash: Buffer.from(params["genesis-hash"], "base64"),
      },
    },
  );
  assertSafeOptIn({ transaction, signer, meta });
  const signed = signer.sign(algosdk.encodeUnsignedTransaction(transaction));
  const submitResponse = await algodRequest(
    "/v2/transactions",
    meta,
    dependencies,
    {
      method: "POST",
      headers: { "content-type": "application/x-binary" },
      body: signed,
    },
  );
  if (!submitResponse.ok) {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      `algod rejected the opt-in (${submitResponse.status})`,
    );
  }
  let txid: string;
  try {
    txid = submitSchema.parse(await submitResponse.json()).txId;
  } catch {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      "algod returned a malformed submit response",
    );
  }
  const pendingResponse = await algodRequest(
    `/v2/transactions/pending/${encodeURIComponent(txid)}`,
    meta,
    dependencies,
  );
  if (!pendingResponse.ok) {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      "could not confirm the USDC opt-in",
    );
  }
  let pending: z.infer<typeof pendingSchema>;
  try {
    pending = pendingSchema.parse(await pendingResponse.json());
  } catch {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      "algod returned a malformed confirmation response",
    );
  }
  if (
    (pending["pool-error"] ?? "") !== "" ||
    (pending["confirmed-round"] ?? 0) <= 0
  ) {
    throw new OscClientError(
      "ALGOD_UNAVAILABLE",
      "USDC opt-in has not confirmed",
    );
  }
  return { txid };
}
