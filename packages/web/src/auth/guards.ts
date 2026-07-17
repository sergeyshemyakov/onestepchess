// Pre-sign guards (F-W2): the fallback auth txn is decoded and every pinned
// field checked BEFORE any signer is invoked — a mismatch produces no
// signature. algosdk arrives with the lazy wallet chunk; this module only
// ever runs inside it.

import type algosdk from "algosdk";

export type FallbackGuardResult =
  | { readonly ok: true; readonly txn: algosdk.Transaction }
  | { readonly ok: false; readonly field: string };

export type FallbackGuardInput = {
  readonly fallbackTxnB64: string;
  readonly address: string;
  readonly nonce: string;
  /** `/meta.network.caip2` — the genesis hash IS the CAIP-2 reference; on
   * `mock:local` the hash check is skipped (CA-R10). */
  readonly caip2: string;
};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export function guardFallbackTxn(
  sdk: typeof algosdk,
  input: FallbackGuardInput,
): FallbackGuardResult {
  let txn: algosdk.Transaction;
  try {
    txn = sdk.decodeUnsignedTransaction(b64ToBytes(input.fallbackTxnB64));
  } catch {
    return { ok: false, field: "decode" };
  }
  const fail = (field: string): FallbackGuardResult => ({ ok: false, field });

  if (txn.type !== sdk.TransactionType.pay || txn.payment === undefined) {
    return fail("type");
  }
  if (txn.sender.toString() !== input.address) return fail("sender");
  if (txn.payment.receiver.toString() !== input.address)
    return fail("receiver");
  if (txn.payment.amount !== 0n) return fail("amount");
  if (txn.fee !== 0n) return fail("fee");
  const note = new TextDecoder().decode(txn.note ?? new Uint8Array());
  if (note !== `osc-auth:${input.nonce}`) return fail("note");
  if (txn.firstValid !== 1n || txn.lastValid !== 1n) return fail("validity");
  if (input.caip2 !== "mock:local") {
    const reference = input.caip2.split(":")[1] ?? "";
    const genesisB64 = bytesToB64(txn.genesisHash ?? new Uint8Array());
    if (reference.length === 0 || !genesisB64.startsWith(reference)) {
      return fail("genesis");
    }
  }
  if (txn.payment.closeRemainderTo !== undefined) return fail("close");
  if (txn.rekeyTo !== undefined) return fail("rekey");
  if (txn.lease !== undefined && txn.lease.length > 0) return fail("lease");
  if (txn.group !== undefined) return fail("group");
  return { ok: true, txn };
}
