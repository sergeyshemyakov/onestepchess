import algosdk from "algosdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Meta } from "../api/schemas.js";
import { loginWithWallet } from "../auth/login.js";
import {
  type ConnectedWallet,
  connectWithStaleSessionRecovery,
  createWalletModule,
} from "./provider.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Release 1 wallet surface", () => {
  it("pera_recovers_a_stale_session_during_the_first_connect_click", async () => {
    const accounts = [{ address: "PERA_ADDRESS" }];
    const provider = {
      connect: vi
        .fn<() => Promise<typeof accounts>>()
        .mockRejectedValueOnce(new Error("stale WalletConnect session"))
        .mockResolvedValueOnce(accounts),
      disconnect: vi.fn(async () => undefined),
    };

    await expect(
      connectWithStaleSessionRecovery(provider, true),
    ).resolves.toEqual(accounts);
    expect(provider.disconnect).toHaveBeenCalledTimes(1);
    expect(provider.connect).toHaveBeenCalledTimes(2);
  });

  it("pera_does_not_reopen_after_the_user_closes_the_connect_modal", async () => {
    const cancelled = Object.assign(new Error("closed"), {
      name: "PeraWalletConnectError",
      data: { type: "CONNECT_MODAL_CLOSED" },
    });
    const provider = {
      connect: vi.fn(async () => {
        throw cancelled;
      }),
      disconnect: vi.fn(async () => undefined),
    };

    await expect(
      connectWithStaleSessionRecovery(provider, true),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });

  it("installs every configured production wallet provider SDK", () => {
    for (const provider of [
      "@perawallet/connect",
      "@blockshake/defly-connect",
      "lute-connect",
    ]) {
      expect(import.meta.resolve(provider)).toContain(provider);
    }
  });

  it("keeps the development mnemonic provider available in dev builds", () => {
    expect(
      createWalletModule({
        includeMnemonic: true,
        walletConnectProjectId: "",
      }).listWallets(),
    ).toEqual([
      { id: "pera", name: "Pera" },
      { id: "defly", name: "Defly" },
      { id: "lute", name: "Lute" },
      { id: "mnemonic", name: "dev wallet (mnemonic)" },
    ]);
  });

  it("invalid mnemonic input explains the error and remains retryable", async () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const prompt = vi
      .fn<(_: string) => string | null>()
      .mockReturnValueOnce("not a mnemonic")
      .mockReturnValueOnce(`  ${mnemonic.replaceAll(" ", "   ")}  `);
    vi.stubGlobal("prompt", prompt);

    const wallet = await createWalletModule({
      includeMnemonic: true,
      walletConnectProjectId: "",
    }).connect("mnemonic");

    expect(wallet.address).toBe(account.addr.toString());
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      "That mnemonic is invalid. Enter a valid 25-word mnemonic passphrase:",
    );
    expect(localStorage.getItem("@txnlab/use-wallet:v4_mnemonic")).toBe(
      mnemonic,
    );
  });

  it("removes a persisted invalid mnemonic before the wallet can reuse it", () => {
    localStorage.setItem("@txnlab/use-wallet:v4_mnemonic", "not a mnemonic");

    createWalletModule({
      includeMnemonic: true,
      walletConnectProjectId: "",
    });

    expect(localStorage.getItem("@txnlab/use-wallet:v4_mnemonic")).toBeNull();
  });
});

it("wallet_auth_prefers_arc60_and_supports_pera_defly_lute", async () => {
  const choices = createWalletModule({
    includeMnemonic: false,
    walletConnectProjectId: "deployment-project-id",
  }).listWallets();
  expect(choices.map((choice) => choice.name)).toEqual([
    "Pera",
    "Defly",
    "Lute",
    "WalletConnect",
  ]);

  const account = algosdk.generateAccount();
  const address = account.addr.toString();
  const challenge = {
    nonce: "nonce-arc60",
    expiresAt: "2026-07-21T15:00:00Z",
    arc60Payload: {
      data: "e30=",
      metadata: { scope: 1, encoding: "base64" },
    },
    fallbackTxnB64: "unused",
  };
  const authVerify = vi.fn(async () => ({
    player: {
      address,
      kind: "human" as const,
      nickname: "lute-player",
      createdAt: "2026-07-21T14:00:00Z",
    },
    jwt: "jwt",
  }));
  const client = {
    authChallenge: vi.fn(async () => challenge),
    authVerify,
  };
  const signData = vi.fn(async () => ({
    signatureB64: "c2ln",
    authenticatorDataB64: "YXV0aA==",
  }));
  const lute: ConnectedWallet = {
    address,
    walletName: "Lute",
    signTransactions: vi.fn(),
    signData,
  };
  const result = await loginWithWallet({
    // biome-ignore lint/suspicious/noExplicitAny: focused auth client double
    client: client as any,
    meta: { network: { caip2: "mock:local" } } as Meta,
    wallet: lute,
  });
  expect(result.kind).toBe("signed-in");
  expect(signData).toHaveBeenCalledWith("e30=", {
    scope: 1,
    encoding: "base64",
  });
  expect(lute.signTransactions).not.toHaveBeenCalled();
  expect(authVerify).toHaveBeenCalledWith({
    address,
    method: "arc60",
    proof: {
      signatureB64: "c2ln",
      authenticatorDataB64: "YXV0aA==",
    },
  });

  const fallbackTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    note: new TextEncoder().encode("osc-auth:nonce-arc60"),
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
  const fallbackClient = {
    authChallenge: vi.fn(async () => ({
      ...challenge,
      fallbackTxnB64: Buffer.from(
        algosdk.encodeUnsignedTransaction(fallbackTxn),
      ).toString("base64"),
    })),
    authVerify: vi.fn(async () => ({
      player: {
        address,
        kind: "human" as const,
        nickname: "pera-player",
        createdAt: "2026-07-21T14:00:00Z",
      },
      jwt: "jwt",
    })),
  };
  const signTransactions = vi.fn(async () => fallbackTxn.signTxn(account.sk));
  const pera: ConnectedWallet = {
    address,
    walletName: "Pera",
    signTransactions,
  };
  const fallbackResult = await loginWithWallet({
    // biome-ignore lint/suspicious/noExplicitAny: focused auth client double
    client: fallbackClient as any,
    meta: { network: { caip2: "mock:local" } } as Meta,
    wallet: pera,
  });
  expect(fallbackResult.kind).toBe("signed-in");
  expect(signTransactions).toHaveBeenCalledTimes(1);
  expect(fallbackClient.authVerify).toHaveBeenCalledWith(
    expect.objectContaining({ method: "txn" }),
  );
});
