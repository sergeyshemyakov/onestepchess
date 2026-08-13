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

export type SafeSweepResult =
  | { readonly ok: true; readonly leg: "algo" | "usdc" }
  | { readonly ok: false };

const UNSAFE: SafeSweepResult = { ok: false };

/** Server-authoritative relay guard for a welcome-bonus return leg. Policy
 * only — algod verifies the signature when the exact bytes are relayed. The
 * only allowed shapes are the ones buildSweepTxns() produces: a full-holding
 * USDC transfer or a plain ALGO payment from the player to the bonus account,
 * flat fee, no close-out, no rekey, the canonical sweep note. */
export function isSafeBonusSweep(
  signedTxnB64: string,
  player: string,
  bonusAddress: string,
  config: ServerConfig,
): SafeSweepResult {
  const bytes = canonicalBase64(signedTxnB64);
  if (bytes === null) return UNSAFE;
  let decoded: algosdk.SignedTransaction;
  try {
    decoded = algosdk.decodeSignedTransaction(bytes);
  } catch {
    return UNSAFE;
  }
  let genesis: GenesisProfile;
  try {
    genesis = genesisForCaip2(config.CAIP2);
  } catch {
    return UNSAFE;
  }
  const txn = decoded.txn;
  const common =
    decoded.sig !== undefined &&
    decoded.msig === undefined &&
    decoded.lsig === undefined &&
    decoded.sgnr === undefined &&
    txn.sender.toString() === player &&
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
    txn.rekeyTo === undefined;
  if (!common) return UNSAFE;
  const note = (leg: "algo" | "usdc"): Uint8Array =>
    new TextEncoder().encode(`osc:sweep:${leg}:${player}`);
  if (txn.type === "axfer") {
    const transfer = txn.assetTransfer;
    return transfer !== undefined &&
      transfer.receiver.toString() === bonusAddress &&
      transfer.amount > 0n &&
      transfer.assetIndex === BigInt(config.USDC_ASA) &&
      transfer.assetSender === undefined &&
      transfer.closeRemainderTo === undefined &&
      txn.note !== undefined &&
      bytesEqual(txn.note, note("usdc"))
      ? { ok: true, leg: "usdc" }
      : UNSAFE;
  }
  if (txn.type === "pay") {
    const paymentTxn = txn.payment;
    return paymentTxn !== undefined &&
      paymentTxn.receiver.toString() === bonusAddress &&
      paymentTxn.amount > 0n &&
      paymentTxn.closeRemainderTo === undefined &&
      txn.note !== undefined &&
      bytesEqual(txn.note, note("algo"))
      ? { ok: true, leg: "algo" }
      : UNSAFE;
  }
  return UNSAFE;
}
