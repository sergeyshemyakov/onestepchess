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

/** Only a deliberate user cancellation may close the sheet silently; every
 * other signing failure (popup blocked, dead WalletConnect session, network
 * mismatch) must surface as an error the user can act on. The wallet SDKs
 * signal cancellation inconsistently — an AbortError, a `data.type` code, or
 * just prose — so all three shapes are checked, each kept narrow enough that
 * failures like SESSION_CLOSED or "rejected because the session expired"
 * stay classified as errors; when unsure, showing an error to a user who
 * cancelled beats silently hiding a real failure. */
export function isSignCancellation(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === "AbortError") return true;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "data" in cause &&
    typeof cause.data === "object" &&
    cause.data !== null &&
    "type" in cause.data &&
    typeof cause.data.type === "string" &&
    (/CANCEL/i.test(cause.data.type) || /_MODAL_CLOSED$/i.test(cause.data.type))
  ) {
    return true;
  }
  const message = cause instanceof Error ? cause.message : "";
  return /\bcancell?ed\b|\buser\s+(rejected|declined|denied)\b|^transaction request rejected$/i.test(
    message,
  );
}

function signFailure(cause: unknown): LoginOutcome {
  if (isSignCancellation(cause)) return { kind: "rejected" };
  const detail = cause instanceof Error ? cause.message.trim() : "";
  return {
    kind: "error",
    message:
      detail === ""
        ? "wallet signing failed — try again"
        : `wallet signing failed: ${detail}`,
  };
}

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
    // ARC-60 signData branch, for wallets that support it.
    let signed: { signatureB64: string; authenticatorDataB64: string };
    try {
      signed = await wallet.signData(challenge.arc60Payload.data, {
        scope: challenge.arc60Payload.metadata.scope,
        encoding: challenge.arc60Payload.metadata.encoding,
      });
    } catch (cause) {
      return signFailure(cause);
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
    } catch (cause) {
      return signFailure(cause);
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
