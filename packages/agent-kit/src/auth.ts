import algosdk from "algosdk";
import { OscClientError } from "./errors.js";
import type { ChallengeResponse, Meta } from "./schemas.js";

export type Signer = {
  readonly address: string;
  sign(bytes: Uint8Array): Uint8Array;
};

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export function guardAuthChallenge(input: {
  readonly challenge: ChallengeResponse;
  readonly signerAddress: string;
  readonly caip2: string;
}): algosdk.Transaction {
  let transaction: algosdk.Transaction;
  try {
    transaction = algosdk.decodeUnsignedTransaction(
      decodeBase64(input.challenge.fallbackTxnB64),
    );
  } catch {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "authentication challenge could not be decoded",
      "fallbackTxnB64",
    );
  }
  const mismatch = (field: string, expected: string, actual: string): never => {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      `authentication challenge ${field} mismatch`,
      `expected ${expected}; got ${actual}`,
    );
  };

  if (
    transaction.type !== algosdk.TransactionType.pay ||
    transaction.payment === undefined
  ) {
    mismatch("type", "pay", transaction.type);
  }
  const payment = transaction.payment;
  if (payment === undefined) {
    throw new OscClientError(
      "NETWORK_MISMATCH",
      "authentication challenge type mismatch",
      `expected pay; got ${transaction.type}`,
    );
  }
  if (transaction.sender.toString() !== input.signerAddress) {
    mismatch("sender", input.signerAddress, transaction.sender.toString());
  }
  if (payment.receiver.toString() !== input.signerAddress) {
    mismatch("receiver", input.signerAddress, payment.receiver.toString());
  }
  if (payment.amount !== 0n) {
    mismatch("amount", "0", payment.amount.toString());
  }
  if (transaction.fee !== 0n) {
    mismatch("fee", "0", transaction.fee.toString());
  }
  const note = new TextDecoder().decode(transaction.note ?? new Uint8Array());
  const expectedNote = `osc-auth:${input.challenge.nonce}`;
  if (note !== expectedNote) mismatch("note", expectedNote, note);
  if (transaction.firstValid !== 1n || transaction.lastValid !== 1n) {
    mismatch(
      "validity",
      "1..1",
      `${transaction.firstValid}..${transaction.lastValid}`,
    );
  }
  if (input.caip2 !== "mock:local") {
    const reference = input.caip2.split(":")[1] ?? "";
    const genesis = encodeBase64(transaction.genesisHash ?? new Uint8Array());
    if (reference.length === 0 || genesis !== reference) {
      mismatch("genesis", reference, genesis);
    }
  }
  if (payment.closeRemainderTo !== undefined) {
    mismatch("close", "absent", "present");
  }
  if (transaction.rekeyTo !== undefined) {
    mismatch("rekey", "absent", "present");
  }
  if (transaction.lease !== undefined && transaction.lease.length > 0) {
    mismatch("lease", "absent", "present");
  }
  if (transaction.group !== undefined) mismatch("group", "absent", "present");
  return transaction;
}

export function signAuthChallenge(input: {
  readonly challenge: ChallengeResponse;
  readonly meta: Meta;
  readonly signer: Signer;
}): string {
  const transaction = guardAuthChallenge({
    challenge: input.challenge,
    signerAddress: input.signer.address,
    caip2: input.meta.network.caip2,
  });
  return encodeBase64(
    input.signer.sign(algosdk.encodeUnsignedTransaction(transaction)),
  );
}
