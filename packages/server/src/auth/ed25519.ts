import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";

// noble v3 ships no default SHA-512; wire node:crypto in once at load.
ed.hashes.sha512 = (message: Uint8Array) =>
  new Uint8Array(createHash("sha512").update(message).digest());

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

export function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
