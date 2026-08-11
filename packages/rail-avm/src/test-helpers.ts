import {
  MOVE_RESOURCE_DESCRIPTION,
  MOVE_RESOURCE_MIME_TYPE,
  moveBazaarExtensions,
  type PaymentChallenge,
  X402_GLOBAL_CHALLENGE_TAG,
} from "@onestepchess/core";
import algosdk from "algosdk";
import type { AvmRailConfig } from "./rail.js";

export const TESTNET_CAIP2 =
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
export const MAINNET_CAIP2 =
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
export const CLAIM_URL = "https://osc.example/api/v1/claims/clm_release4/move";

export function accountConfig(caip2 = TESTNET_CAIP2) {
  const treasury = algosdk.generateAccount();
  const bonus = algosdk.generateAccount();
  const config: AvmRailConfig = {
    caip2,
    usdcAsaId: caip2 === TESTNET_CAIP2 ? 10_458_941 : 31_566_704,
    algodUrl: "https://algod.example",
    indexerUrl: "https://indexer.example",
    facilitatorUrl: "https://facilitator.example",
    treasuryMnemonic: algosdk.secretKeyToMnemonic(treasury.sk),
    bonusMnemonic: algosdk.secretKeyToMnemonic(bonus.sk),
    requestTimeoutMs: 20,
  };
  return { config, treasury, bonus };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function supported(
  caip2: string,
  feePayer: string,
  options: {
    readonly scheme?: string;
    readonly network?: string;
    readonly signerFamily?: string;
    readonly signer?: string;
    readonly includeFeePayer?: boolean;
  } = {},
): Response {
  const network = options.network ?? caip2;
  return json({
    kinds: [
      {
        x402Version: 2,
        scheme: options.scheme ?? "exact",
        network,
        extra: options.includeFeePayer === false ? {} : { feePayer },
      },
    ],
    extensions: [],
    signers: {
      [options.signerFamily ?? "algorand:*"]: [options.signer ?? feePayer],
    },
  });
}

export function suggestedParams(
  caip2 = TESTNET_CAIP2,
  options: {
    readonly round?: number;
    readonly minFee?: number;
    readonly genesisHash?: string;
  } = {},
): Response {
  return json({
    fee: 1,
    "min-fee": options.minFee ?? 1_000,
    "last-round": options.round ?? 20_000,
    "genesis-id": "fixture-v1",
    "genesis-hash": options.genesisHash ?? caip2.slice("algorand:".length),
    "consensus-version": "fixture",
  });
}

export function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export type ExactPaymentPayloadFixture = {
  x402Version: 2;
  resource: { url: string; description?: string; mimeType?: string };
  accepted: PaymentChallenge["required"]["accepts"][0];
  extensions: Readonly<Record<string, unknown>>;
  payload: { paymentGroup: string[]; paymentIndex: number };
};

export function exactPaymentFixture(args: {
  readonly payer: algosdk.Account;
  readonly feePayer: string;
  readonly treasury: string;
  readonly caip2?: string;
  readonly asaId?: number;
  readonly amount?: number;
  readonly resource?: string;
  readonly mutate?: (payload: ExactPaymentPayloadFixture) => void;
}) {
  const caip2 = args.caip2 ?? TESTNET_CAIP2;
  const asaId = args.asaId ?? 10_458_941;
  const amount = args.amount ?? 1_000;
  const params = {
    flatFee: true,
    fee: 0,
    minFee: 1_000,
    firstValid: 20_000,
    lastValid: 21_000,
    genesisID: "fixture-v1",
    genesisHash: Buffer.from(caip2.slice("algorand:".length), "base64"),
  };
  const feeTransaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: args.feePayer,
    receiver: args.feePayer,
    amount: 0,
    suggestedParams: { ...params, fee: 2_000 },
  });
  const paymentTransaction =
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: args.payer.addr,
      receiver: args.treasury,
      amount,
      assetIndex: asaId,
      suggestedParams: params,
    });
  algosdk.assignGroupID([feeTransaction, paymentTransaction]);
  const payload: ExactPaymentPayloadFixture = {
    x402Version: 2,
    resource: {
      url: args.resource ?? CLAIM_URL,
      description: MOVE_RESOURCE_DESCRIPTION,
      mimeType: MOVE_RESOURCE_MIME_TYPE,
    },
    accepted: {
      scheme: "exact",
      network: caip2,
      asset: String(asaId),
      amount: String(amount),
      payTo: args.treasury,
      maxTimeoutSeconds: 120,
      extra: {
        feePayer: args.feePayer,
        decimals: 6,
        tag: X402_GLOBAL_CHALLENGE_TAG,
      },
    },
    extensions: moveBazaarExtensions(),
    payload: {
      paymentGroup: [
        Buffer.from(algosdk.encodeUnsignedTransaction(feeTransaction)).toString(
          "base64",
        ),
        Buffer.from(paymentTransaction.signTxn(args.payer.sk)).toString(
          "base64",
        ),
      ],
      paymentIndex: 1,
    },
  };
  args.mutate?.(payload);
  return {
    header: encodeJson(payload),
    payload,
    feeTransaction,
    paymentTransaction,
  };
}

export function signedClientTransaction(
  account: algosdk.Account,
  caip2 = TESTNET_CAIP2,
): string {
  const transaction = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
    {
      sender: account.addr,
      receiver: account.addr,
      amount: 0,
      assetIndex: 10_458_941,
      suggestedParams: {
        flatFee: true,
        fee: 1_000,
        minFee: 1_000,
        firstValid: 20_000,
        lastValid: 21_000,
        genesisID: "fixture-v1",
        genesisHash: Buffer.from(caip2.slice("algorand:".length), "base64"),
      },
    },
  );
  return Buffer.from(transaction.signTxn(account.sk)).toString("base64");
}

export function hangsUntilAbort(
  onAbort?: (signal: AbortSignal) => void,
): typeof globalThis.fetch {
  return async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        if (init?.signal !== undefined && init.signal !== null) {
          onAbort?.(init.signal);
        }
        reject(init?.signal?.reason);
      });
    });
}
