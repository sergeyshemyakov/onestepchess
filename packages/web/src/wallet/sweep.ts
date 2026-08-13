import algosdk from "algosdk";
import type { ApiClient } from "../api/client.js";
import type { BonusSweepQuote, Meta } from "../api/schemas.js";
import { bytesToBase64 } from "./optin.js";
import type { ConnectedWallet } from "./provider.js";

export class UnsafeSweepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSweepError";
  }
}

function canonicalBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new UnsafeSweepError("bonus-return transaction is malformed");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64(bytes) !== value) {
    throw new UnsafeSweepError("bonus-return transaction is malformed");
  }
  return bytes;
}

function empty(value: Uint8Array | undefined): boolean {
  return value === undefined || value.length === 0;
}

function genesisHash(transaction: algosdk.Transaction): string {
  return bytesToBase64(transaction.genesisHash ?? new Uint8Array());
}

/** Local safety check before the wallet ever sees a server-built return leg:
 * funds may only move from this account to the quoted receiver, flat fee, no
 * close-out, no rekey — a compromised quote cannot redirect the wallet. */
export function guardBonusSweepTxn(input: {
  readonly unsignedTxnB64: string;
  readonly leg: "usdc" | "algo";
  readonly address: string;
  readonly receiver: string;
  readonly meta: Meta;
}): algosdk.Transaction {
  let transaction: algosdk.Transaction;
  try {
    transaction = algosdk.decodeUnsignedTransaction(
      canonicalBase64(input.unsignedTxnB64),
    );
  } catch (cause) {
    if (cause instanceof UnsafeSweepError) throw cause;
    throw new UnsafeSweepError("bonus-return transaction is malformed");
  }
  const expectedGenesis = input.meta.network.caip2.split(":")[1];
  const genesisMatches =
    input.meta.network.caip2 === "mock:local" ||
    (expectedGenesis !== undefined &&
      expectedGenesis.length > 0 &&
      genesisHash(transaction) === expectedGenesis);
  const expectedNote = new TextEncoder().encode(
    `osc:sweep:${input.leg}:${input.address}`,
  );
  const noteMatches =
    transaction.note !== undefined &&
    transaction.note.length === expectedNote.length &&
    transaction.note.every((byte, index) => byte === expectedNote[index]);
  const common =
    transaction.sender.toString() === input.address &&
    transaction.fee === 1_000n &&
    transaction.firstValid <= transaction.lastValid &&
    transaction.lastValid <= transaction.firstValid + 1_000n &&
    genesisMatches &&
    transaction.group === undefined &&
    empty(transaction.lease) &&
    noteMatches &&
    transaction.rekeyTo === undefined;
  const transfer = transaction.assetTransfer;
  const paymentTxn = transaction.payment;
  const legMatches =
    input.leg === "usdc"
      ? transaction.type === "axfer" &&
        transfer !== undefined &&
        transfer.receiver.toString() === input.receiver &&
        transfer.amount > 0n &&
        transfer.assetIndex.toString() === input.meta.network.usdcAssetId &&
        transfer.assetSender === undefined &&
        transfer.closeRemainderTo === undefined &&
        paymentTxn === undefined
      : transaction.type === "pay" &&
        paymentTxn !== undefined &&
        paymentTxn.receiver.toString() === input.receiver &&
        paymentTxn.amount > 0n &&
        paymentTxn.closeRemainderTo === undefined &&
        transfer === undefined;
  if (!common || !legMatches) {
    throw new UnsafeSweepError(
      "bonus-return transaction failed the local safety check",
    );
  }
  return transaction;
}

export async function signAndSubmitBonusSweep(input: {
  readonly client: Pick<ApiClient, "submitBonusSweep">;
  readonly quote: BonusSweepQuote;
  readonly address: string;
  readonly meta: Meta;
  readonly getWallet: () => Promise<ConnectedWallet>;
}): Promise<void> {
  const transactions = input.quote.txns.map((txn) =>
    guardBonusSweepTxn({
      unsignedTxnB64: txn.unsignedTxnB64,
      leg: txn.leg,
      address: input.address,
      receiver: input.quote.receiver,
      meta: input.meta,
    }),
  );
  const wallet = await input.getWallet();
  if (wallet.address !== input.address) {
    throw new UnsafeSweepError("connected wallet does not match this account");
  }
  // One signTransactions call per leg — the wallet adapter returns a single
  // signed payload per call.
  const signed: string[] = [];
  for (const transaction of transactions) {
    signed.push(bytesToBase64(await wallet.signTransactions([transaction])));
  }
  await input.client.submitBonusSweep(signed);
}
