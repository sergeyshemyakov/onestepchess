import algosdk from "algosdk";
import { sha256, verifyEd25519 } from "./ed25519.js";

export type Arc60Proof = {
  readonly signatureB64: string;
  readonly authenticatorDataB64: string;
};

/** ARC-60 structured-data verification (§6.3): the first 32 authenticator-
 * data bytes must equal SHA-256(domain), then Ed25519 verifies over
 * SHA-256(canonical SIWA JSON) || SHA-256(authenticatorData) against the
 * address key. */
export function verifyArc60(
  address: string,
  domain: string,
  storedSiwaB64: string,
  proof: Arc60Proof,
): boolean {
  let signature: Uint8Array;
  let authenticatorData: Uint8Array;
  try {
    signature = new Uint8Array(Buffer.from(proof.signatureB64, "base64"));
    authenticatorData = new Uint8Array(
      Buffer.from(proof.authenticatorDataB64, "base64"),
    );
  } catch {
    return false;
  }
  if (authenticatorData.length < 32) {
    return false;
  }
  const domainHash = sha256(domain);
  for (let index = 0; index < 32; index += 1) {
    if (authenticatorData[index] !== domainHash[index]) {
      return false;
    }
  }
  const siwaBytes = new Uint8Array(Buffer.from(storedSiwaB64, "base64"));
  const message = new Uint8Array([
    ...sha256(siwaBytes),
    ...sha256(authenticatorData),
  ]);
  const publicKey = algosdk.decodeAddress(address).publicKey;
  return verifyEd25519(signature, message, publicKey);
}
