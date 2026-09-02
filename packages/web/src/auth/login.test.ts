import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import type { Meta } from "../api/schemas.js";
import type { ConnectedWallet } from "../wallet/provider.js";
import { loginWithWallet } from "./login.js";

const meta = { network: { caip2: "mock:local" } } as Meta;

function fallbackChallenge(address: string) {
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    note: new TextEncoder().encode("osc-auth:nonce-classify"),
    suggestedParams: {
      flatFee: true,
      fee: 0,
      minFee: 1_000,
      firstValid: 1,
      lastValid: 1,
      genesisHash: new Uint8Array(32),
      genesisID: "mainnet-v1.0",
    },
  });
  return {
    nonce: "nonce-classify",
    expiresAt: "2026-09-01T15:00:00Z",
    arc60Payload: {
      data: "e30=",
      metadata: { scope: 1 as const, encoding: "base64" as const },
    },
    fallbackTxnB64: Buffer.from(
      algosdk.encodeUnsignedTransaction(txn),
    ).toString("base64"),
  };
}

function loginDeps(signTransactions: () => Promise<Uint8Array>) {
  const address = algosdk.generateAccount().addr.toString();
  const authVerify = vi.fn();
  const wallet: ConnectedWallet = {
    address,
    walletName: "Pera",
    signTransactions,
  };
  const client = {
    authChallenge: vi.fn(async () => fallbackChallenge(address)),
    authVerify,
  };
  return {
    // biome-ignore lint/suspicious/noExplicitAny: focused auth client double
    client: client as any,
    meta,
    wallet,
    authVerify,
  };
}

describe("sign failure classification (F-W2)", () => {
  it("wallet_cancellation_type_maps_to_rejected", async () => {
    const cancelled = Object.assign(new Error("Confirmation Failed"), {
      data: { type: "SIGN_TXN_CANCELLED" },
    });
    const { authVerify, ...deps } = loginDeps(async () => {
      throw cancelled;
    });
    const outcome = await loginWithWallet(deps);
    expect(outcome.kind).toBe("rejected");
    expect(authVerify).not.toHaveBeenCalled();
  });

  it("wallet_rejection_message_maps_to_rejected", async () => {
    const { authVerify, ...deps } = loginDeps(async () => {
      throw new Error("User rejected the request");
    });
    const outcome = await loginWithWallet(deps);
    expect(outcome.kind).toBe("rejected");
    expect(authVerify).not.toHaveBeenCalled();
  });

  it("abort_named_errors_map_to_rejected", async () => {
    const abort = new Error("mnemonic entry cancelled");
    abort.name = "AbortError";
    const { authVerify, ...deps } = loginDeps(async () => {
      throw abort;
    });
    const outcome = await loginWithWallet(deps);
    expect(outcome.kind).toBe("rejected");
    expect(authVerify).not.toHaveBeenCalled();
  });

  it("pera_style_request_rejection_maps_to_rejected", async () => {
    const { authVerify, ...deps } = loginDeps(async () => {
      throw new Error("Transaction Request Rejected");
    });
    const outcome = await loginWithWallet(deps);
    expect(outcome.kind).toBe("rejected");
    expect(authVerify).not.toHaveBeenCalled();
  });

  it("session_closed_type_is_a_failure_not_a_cancellation", async () => {
    const dead = Object.assign(new Error("WalletConnect session closed"), {
      data: { type: "SESSION_CLOSED" },
    });
    const { authVerify, ...deps } = loginDeps(async () => {
      throw dead;
    });
    const outcome = await loginWithWallet(deps);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    expect(outcome.message).toContain("session closed");
    expect(authVerify).not.toHaveBeenCalled();
  });

  it("non_user_rejection_prose_is_a_failure_not_a_cancellation", async () => {
    const { authVerify, ...deps } = loginDeps(async () => {
      throw new Error("Transaction rejected: the session has expired");
    });
    const outcome = await loginWithWallet(deps);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    expect(outcome.message).toContain("session has expired");
    expect(authVerify).not.toHaveBeenCalled();
  });

  it("non_cancellation_sign_failure_surfaces_an_error", async () => {
    const mismatch = Object.assign(
      new Error("Signing error: network mismatch"),
      { data: { type: "SIGN_TXN_NETWORK_MISMATCH" } },
    );
    const { authVerify, ...deps } = loginDeps(async () => {
      throw mismatch;
    });
    const outcome = await loginWithWallet(deps);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    expect(outcome.message).toContain("network mismatch");
    expect(authVerify).not.toHaveBeenCalled();
  });

  it("arc60_sign_failure_surfaces_an_error", async () => {
    const address = algosdk.generateAccount().addr.toString();
    const authVerify = vi.fn();
    const wallet: ConnectedWallet = {
      address,
      walletName: "arc60-capable",
      signTransactions: vi.fn(),
      signData: async () => {
        throw new Error("signData popup did not load");
      },
    };
    const client = {
      authChallenge: vi.fn(async () => fallbackChallenge(address)),
      authVerify,
    };
    const outcome = await loginWithWallet({
      // biome-ignore lint/suspicious/noExplicitAny: focused auth client double
      client: client as any,
      meta,
      wallet,
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    expect(outcome.message).toContain("signData popup did not load");
    expect(authVerify).not.toHaveBeenCalled();
  });
});
