import { type ApiClient, ApiError } from "../api/client.js";
import type { Meta, PlayerView, VerifyResponse } from "../api/schemas.js";
import type { ConnectedWallet } from "../wallet/provider.js";
import { bytesToB64, guardFallbackTxn } from "./guards.js";

// F-W2: challenge → guarded signing → verify. Runs only from the lazy
// wallet path — algosdk is imported dynamically here, never statically
// from the root bundle.

export type PendingRegistration = {
  readonly address: string;
  /** The still-live proof — recoverable registration errors reuse it
   * without another wallet prompt (server §6.3). */
  readonly resubmit: (fields: {
    readonly nickname: string;
    readonly turnstileToken: string;
  }) => Promise<VerifyResponse>;
};

export type LoginOutcome =
  | {
      readonly kind: "signed-in";
      readonly player: PlayerView;
      readonly linkedGuestClaims?: number;
    }
  | {
      readonly kind: "registration-required";
      readonly pending: PendingRegistration;
    }
  /** Wallet reject at any step → back to the landing, no state change. */
  | { readonly kind: "rejected" }
  | { readonly kind: "error"; readonly message: string };

export async function loginWithWallet(deps: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly wallet: ConnectedWallet;
  readonly ref?: string;
}): Promise<LoginOutcome> {
  const { client, meta, wallet } = deps;
  const challenge = await client.authChallenge(wallet.address);

  let proofBody: Record<string, unknown>;
  if (wallet.signData !== undefined) {
    // ARC-60 signData branch (Lute).
    let signed: { signatureB64: string; authenticatorDataB64: string };
    try {
      signed = await wallet.signData(challenge.arc60Payload.data, {
        scope: challenge.arc60Payload.metadata.scope,
        encoding: challenge.arc60Payload.metadata.encoding,
      });
    } catch {
      return { kind: "rejected" };
    }
    proofBody = {
      method: "arc60",
      proof: {
        signatureB64: signed.signatureB64,
        authenticatorDataB64: signed.authenticatorDataB64,
      },
    };
  } else {
    // Fallback-txn branch: decode and require the exact pinned field set
    // BEFORE signTransactions — a mismatch never reaches the wallet.
    const sdk = (await import("algosdk")).default;
    const guarded = guardFallbackTxn(sdk, {
      fallbackTxnB64: challenge.fallbackTxnB64,
      address: wallet.address,
      nonce: challenge.nonce,
      caip2: meta.network.caip2,
    });
    if (!guarded.ok) {
      return {
        kind: "error",
        message: `auth transaction failed the ${guarded.field} check — nothing was signed`,
      };
    }
    let signedBytes: Uint8Array;
    try {
      signedBytes = await wallet.signTransactions([guarded.txn]);
    } catch {
      return { kind: "rejected" };
    }
    proofBody = { method: "txn", signedTxnB64: bytesToB64(signedBytes) };
  }

  return submitVerify(
    client,
    { address: wallet.address, ...proofBody },
    deps.ref,
  );
}

async function submitVerify(
  client: ApiClient,
  body: Record<string, unknown>,
  ref?: string,
): Promise<LoginOutcome> {
  try {
    const response = await client.authVerify(body);
    return {
      kind: "signed-in",
      player: response.player,
      ...(response.linkedGuestClaims === undefined
        ? {}
        : { linkedGuestClaims: response.linkedGuestClaims }),
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === "REGISTRATION_REQUIRED") {
      return {
        kind: "registration-required",
        pending: {
          address: body.address as string,
          resubmit: (fields) =>
            client.authVerify({
              ...body,
              kind: "human",
              ...fields,
              ...(ref === undefined ? {} : { ref }),
            }),
        },
      };
    }
    if (error instanceof ApiError) {
      return { kind: "error", message: error.envelope.hint };
    }
    return { kind: "error", message: "connection failed — try again" };
  }
}
