import { randomBytes } from "node:crypto";
import type { PaymentRail } from "@onestepchess/core";
import { RailError } from "@onestepchess/core";
import algosdk from "algosdk";
import { canonify } from "canonify";
import { eq } from "drizzle-orm";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { AppError } from "../http/app.js";
import { genesisForCaip2 } from "./genesis.js";
import { verifyArc60 } from "./verify-arc60.js";
import { verifyFallbackTxn } from "./verify-txn.js";

export type AuthDeps = {
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly config: () => ServerConfig;
  readonly publicBaseUrl: string;
  readonly now: () => number;
};

export type ChallengeResponse = {
  readonly nonce: string;
  readonly expiresAt: string;
  readonly arc60Payload: {
    readonly data: string;
    readonly metadata: { readonly scope: 1; readonly encoding: "base64" };
  };
  readonly fallbackTxnB64: string;
};

export type ProofInput =
  | {
      readonly method: "arc60";
      readonly signatureB64: string;
      readonly authenticatorDataB64: string;
    }
  | { readonly method: "txn"; readonly signedTxnB64: string };

export type VerifyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "NONCE_EXPIRED"
        | "INVALID_SIGNATURE"
        | "REKEYED_UNSUPPORTED"
        | "DEPENDENCY_UNAVAILABLE";
    };

export function createChallenge(
  deps: AuthDeps,
  address: string,
): ChallengeResponse {
  if (!algosdk.isValidAddress(address)) {
    throw new AppError("INVALID_ADDRESS", {
      hint: "not a valid Algorand address",
    });
  }
  const now = deps.now();
  const config = deps.config();
  const expiresAtMs = now + config.NONCE_TTL_SECONDS * 1_000;
  const nonce = randomBytes(16).toString("hex");
  const base = new URL(deps.publicBaseUrl);

  // Canonical SIWA JSON, matching use-wallet's shape (§6.3).
  const siwa = canonify({
    domain: base.host,
    account_address: address,
    uri: base.origin,
    version: "1",
    statement: "Sign in to One Step Chess",
    nonce,
    "issued-at": new Date(now).toISOString(),
    "expiration-time": new Date(expiresAtMs).toISOString(),
    chain_id: "283",
    type: "ed25519",
  });
  if (siwa === undefined) {
    throw new Error("failed to canonify the SIWA payload");
  }
  const arc60DataB64 = Buffer.from(siwa, "utf8").toString("base64");

  // Invalid by construction: expired window plus zero standalone fee — a
  // signing artifact only, never broadcast (§6.3).
  const genesis = genesisForCaip2(config.CAIP2);
  const fallbackTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    note: new TextEncoder().encode(`osc-auth:${nonce}`),
    suggestedParams: {
      fee: 0,
      flatFee: true,
      minFee: 1_000,
      firstValid: 1,
      lastValid: 1,
      genesisHash: new Uint8Array(Buffer.from(genesis.hashB64, "base64")),
      genesisID: genesis.id,
    },
  });
  const fallbackTxnB64 = Buffer.from(
    algosdk.encodeUnsignedTransaction(fallbackTxn),
  ).toString("base64");

  deps.db
    .insert(schema.authNonces)
    .values({
      address,
      nonce,
      arc60DataB64,
      fallbackUnsignedB64: fallbackTxnB64,
      expiresAt: expiresAtMs,
    })
    .onConflictDoUpdate({
      target: schema.authNonces.address,
      set: {
        nonce,
        arc60DataB64,
        fallbackUnsignedB64: fallbackTxnB64,
        expiresAt: expiresAtMs,
      },
    })
    .run();

  return {
    nonce,
    expiresAt: new Date(expiresAtMs).toISOString(),
    arc60Payload: {
      data: arc60DataB64,
      metadata: { scope: 1, encoding: "base64" },
    },
    fallbackTxnB64,
  };
}

/** Verifies a proof against the live challenge without consuming it —
 * recoverable registration errors may re-verify the same proof (F2). */
export async function verifyChallengeProof(
  deps: AuthDeps,
  address: string,
  proof: ProofInput,
): Promise<VerifyOutcome> {
  const row = deps.db
    .select()
    .from(schema.authNonces)
    .where(eq(schema.authNonces.address, address))
    .get();
  if (row === undefined || row.expiresAt <= deps.now()) {
    return { ok: false, code: "NONCE_EXPIRED" };
  }

  // Rekey rejection comes before any key verification (F2 step 2).
  try {
    const info = await deps.rail.getAccountInfo(address);
    if (info.rekeyed) {
      return { ok: false, code: "REKEYED_UNSUPPORTED" };
    }
  } catch (error) {
    if (error instanceof RailError && error.code !== "CONTRACT") {
      return { ok: false, code: "DEPENDENCY_UNAVAILABLE" };
    }
    throw error;
  }

  const verified =
    proof.method === "arc60"
      ? verifyArc60(
          address,
          new URL(deps.publicBaseUrl).host,
          row.arc60DataB64,
          proof,
        )
      : verifyFallbackTxn(address, row.fallbackUnsignedB64, proof);
  return verified ? { ok: true } : { ok: false, code: "INVALID_SIGNATURE" };
}

/** Deletes the nonce — called only after a fully successful verify (F2). */
export function consumeChallenge(db: Db, address: string): void {
  db.delete(schema.authNonces)
    .where(eq(schema.authNonces.address, address))
    .run();
}
