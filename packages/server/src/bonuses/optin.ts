import algosdk from "algosdk";
import { type GenesisProfile, genesisForCaip2 } from "../auth/genesis.js";
import type { ServerConfig } from "../config.js";

function canonicalBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.toString("base64") === value
    ? new Uint8Array(bytes)
    : null;
}

function empty(value: Uint8Array | undefined): boolean {
  return value === undefined || value.length === 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

/** Server-authoritative relay guard. It validates policy only; algod performs
 * signature verification when the exact bytes are relayed. */
export function isSafeBonusOptIn(
  signedTxnB64: string,
  player: string,
  config: ServerConfig,
): boolean {
  const bytes = canonicalBase64(signedTxnB64);
  if (bytes === null) return false;
  let decoded: algosdk.SignedTransaction;
  try {
    decoded = algosdk.decodeSignedTransaction(bytes);
  } catch {
    return false;
  }
  const txn = decoded.txn;
  const transfer = txn.assetTransfer;
  let genesis: GenesisProfile;
  try {
    genesis = genesisForCaip2(config.CAIP2);
  } catch {
    return false;
  }
  return (
    decoded.sig !== undefined &&
    decoded.msig === undefined &&
    decoded.lsig === undefined &&
    decoded.sgnr === undefined &&
    txn.type === "axfer" &&
    txn.sender.toString() === player &&
    transfer !== undefined &&
    transfer.receiver.toString() === player &&
    transfer.amount === 0n &&
    transfer.assetIndex === BigInt(config.USDC_ASA) &&
    transfer.assetSender === undefined &&
    transfer.closeRemainderTo === undefined &&
    txn.fee === 1_000n &&
    txn.firstValid <= txn.lastValid &&
    txn.lastValid <= txn.firstValid + 1_000n &&
    txn.genesisID === genesis.id &&
    txn.genesisHash !== undefined &&
    bytesEqual(
      txn.genesisHash,
      new Uint8Array(Buffer.from(genesis.hashB64, "base64")),
    ) &&
    txn.group === undefined &&
    empty(txn.lease) &&
    empty(txn.note) &&
    txn.rekeyTo === undefined
  );
}
