import algosdk from "algosdk";
import { verifyEd25519 } from "./ed25519.js";

export type TxnProof = {
  readonly signedTxnB64: string;
};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/** Fallback-transaction verification (§6.3): the embedded unsigned txn must
 * equal the stored challenge byte-for-byte, and sender + signature must
 * match the address. No chain I/O — the txn is invalid by construction and
 * never broadcast. */
export function verifyFallbackTxn(
  address: string,
  storedUnsignedB64: string,
  proof: TxnProof,
): boolean {
  let decoded: algosdk.SignedTransaction;
  try {
    decoded = algosdk.decodeSignedTransaction(
      new Uint8Array(Buffer.from(proof.signedTxnB64, "base64")),
    );
  } catch {
    return false;
  }
  if (decoded.sig === undefined || decoded.sgnr !== undefined) {
    return false;
  }
  const embedded = algosdk.encodeUnsignedTransaction(decoded.txn);
  const stored = new Uint8Array(Buffer.from(storedUnsignedB64, "base64"));
  if (!bytesEqual(embedded, stored)) {
    return false;
  }
  if (decoded.txn.sender.toString() !== address) {
    return false;
  }
  const publicKey = algosdk.decodeAddress(address).publicKey;
  return verifyEd25519(
    new Uint8Array(decoded.sig),
    decoded.txn.bytesToSign(),
    publicKey,
  );
}
