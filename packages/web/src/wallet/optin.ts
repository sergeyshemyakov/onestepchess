import algosdk from "algosdk";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/http.js";
import type { Meta } from "../api/schemas.js";
import type { ConnectedWallet } from "./provider.js";

export class UnsafeOptInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOptInError";
  }
}

function canonicalBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new UnsafeOptInError("starter-stake transaction is malformed");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64(bytes) !== value) {
    throw new UnsafeOptInError("starter-stake transaction is malformed");
  }
  return bytes;
}

function empty(value: Uint8Array | undefined): boolean {
  return value === undefined || value.length === 0;
}

function genesisHash(transaction: algosdk.Transaction): string {
  return bytesToBase64(transaction.genesisHash ?? new Uint8Array());
}

export function guardStarterStakeOptIn(input: {
  readonly unsignedTxnB64: string;
  readonly address: string;
  readonly meta: Meta;
}): algosdk.Transaction {
  let transaction: algosdk.Transaction;
  try {
    transaction = algosdk.decodeUnsignedTransaction(
      canonicalBase64(input.unsignedTxnB64),
    );
  } catch (cause) {
    if (cause instanceof UnsafeOptInError) throw cause;
    throw new UnsafeOptInError("starter-stake transaction is malformed");
  }
  const transfer = transaction.assetTransfer;
  const expectedGenesis = input.meta.network.caip2.split(":")[1];
  const genesisMatches =
    input.meta.network.caip2 === "mock:local" ||
    (expectedGenesis !== undefined &&
      expectedGenesis.length > 0 &&
      genesisHash(transaction) === expectedGenesis);
  if (
    transaction.type !== "axfer" ||
    transaction.sender.toString() !== input.address ||
    transfer === undefined ||
    transfer.receiver.toString() !== input.address ||
    transfer.amount !== 0n ||
    transfer.assetIndex.toString() !== input.meta.network.usdcAssetId ||
    transfer.assetSender !== undefined ||
    transfer.closeRemainderTo !== undefined ||
    transaction.fee !== 1_000n ||
    transaction.firstValid > transaction.lastValid ||
    transaction.lastValid > transaction.firstValid + 1_000n ||
    !genesisMatches ||
    transaction.group !== undefined ||
    !empty(transaction.lease) ||
    !empty(transaction.note) ||
    transaction.rekeyTo !== undefined ||
    transaction.payment !== undefined
  ) {
    throw new UnsafeOptInError(
      "starter-stake transaction failed the local safety check",
    );
  }
  return transaction;
}

export async function submitStarterStakeOptIn(input: {
  readonly client: Pick<ApiClient, "getBonusOptInTxn" | "submitBonusOptIn">;
  readonly address: string;
  readonly meta: Meta;
  readonly getWallet: () => Promise<ConnectedWallet>;
}): Promise<"watching"> {
  const unsignedTxnB64 = await input.client.getBonusOptInTxn();
  const transaction = guardStarterStakeOptIn({
    unsignedTxnB64,
    address: input.address,
    meta: input.meta,
  });
  const wallet = await input.getWallet();
  if (wallet.address !== input.address) {
    throw new UnsafeOptInError("connected wallet does not match this account");
  }
  const signed = await wallet.signTransactions([transaction]);
  try {
    await input.client.submitBonusOptIn(bytesToBase64(signed));
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    // A lost relay response is ambiguous. The server watcher is the source of
    // truth, so the browser waits instead of sending the signed txn twice.
  }
  return "watching";
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
