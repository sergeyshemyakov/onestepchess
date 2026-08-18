import algosdk from "algosdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Meta } from "../api/schemas.js";
import { loginWithWallet } from "../auth/login.js";
import {
  brandedWalletChainId,
  type ConnectedWallet,
  connectWithStaleSessionRecovery,
  createWalletModule,
  networkIdForCaip2,
  recoversStaleSession,
  usesArc60SignData,
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

  it("defly_and_walletconnect_recover_a_stale_session_like_pera", () => {
    expect(recoversStaleSession("pera")).toBe(true);
    expect(recoversStaleSession("defly")).toBe(true);
    expect(recoversStaleSession("walletconnect")).toBe(true);
    // Lute is not WalletConnect-based, so it has no stale session to recover;
    // a retry would also reopen its popup outside the user's click gesture.
    expect(recoversStaleSession("lute")).toBe(false);
    expect(recoversStaleSession("mnemonic")).toBe(false);
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

  it("lute_authenticates_via_the_fallback_txn_path_not_arc60", () => {
    // lute.app/auth crashes to a blank popup when the browser strips
    // cross-site referrers (Brave default, hardened Firefox); its /sign page
    // renders without a referrer, so Lute must never expose signData even
    // though its SDK advertises support.
    expect(usesArc60SignData("lute", true)).toBe(false);
    // Wallets without signData stay on the fallback-txn path as before.
    expect(usesArc60SignData("pera", false)).toBe(false);
    // A future ARC-60-capable wallet keeps the signData branch.
    expect(usesArc60SignData("exodus", true)).toBe(true);
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

  it("wallet_login_targets_testnet_network_for_a_testnet_deployment", () => {
    // The deployment's CAIP-2 network — not a hardcoded MAINNET — drives which
    // network the branded wallets (Pera/Defly/etc.) are asked to connect on. A
    // testnet server must ask Pera for testnet or Pera reports a network
    // mismatch and never reaches the (testnet-aware) signing step.
    expect(
      networkIdForCaip2(
        "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
      ),
    ).toBe("testnet");
    expect(
      networkIdForCaip2(
        "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
      ),
    ).toBe("mainnet");
    // mock:local keeps the mainnet profile so the never-submitted fallback
    // auth artifact renders consistently in real wallet apps (§6.3).
    expect(networkIdForCaip2("mock:local")).toBe("mainnet");
  });

  it("pera_and_defly_declare_the_testnet_chain_id_on_a_testnet_deployment", () => {
    // use-wallet builds the Pera/Defly SDK clients from the STATIC registration
    // options and never forwards the active network, and those SDKs default to
    // chainId 4160 which they treat as mainnet. A testnet Pera app then rejects
    // the sign request with SIGN_TXN_NETWORK_MISMATCH. The deployment CAIP-2
    // must therefore be baked into the branded wallet options as the numeric
    // Algorand chain id (416001 mainnet / 416002 testnet).
    expect(
      brandedWalletChainId(
        "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
      ),
    ).toBe(416002);
    expect(
      brandedWalletChainId(
        "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
      ),
    ).toBe(416001);
    expect(brandedWalletChainId("mock:local")).toBe(416001);
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

  it("resume_restores_the_persisted_wallet_session_after_a_reload", async () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    vi.stubGlobal(
      "prompt",
      vi.fn(() => mnemonic),
    );
    await createWalletModule({
      includeMnemonic: true,
      walletConnectProjectId: "",
    }).connect("mnemonic");

    // A fresh module simulates a page reload: use-wallet's persisted session
    // exists in localStorage, but nothing is connected in memory yet.
    const reloaded = createWalletModule({
      includeMnemonic: true,
      walletConnectProjectId: "",
    });
    expect(reloaded.current()).toBeNull();

    await reloaded.resume();

    expect(reloaded.current()?.address).toBe(account.addr.toString());
  });

  it("resume_ignores_dead_inactive_wallet_sessions", async () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const activeAccount = {
      name: "Mnemonic Account",
      address: account.addr.toString(),
    };
    localStorage.setItem(
      "@txnlab/use-wallet:v4",
      JSON.stringify({
        wallets: {
          mnemonic: { accounts: [activeAccount], activeAccount },
          lute: { accounts: [activeAccount], activeAccount },
        },
        activeWallet: "mnemonic",
        activeNetwork: "localnet",
        customNetworkConfigs: {},
      }),
    );
    localStorage.setItem("@txnlab/use-wallet:v4_mnemonic", mnemonic);
    const prompt = vi.fn<() => string | null>(() => null);
    vi.stubGlobal("prompt", prompt);

    const reloaded = createWalletModule({
      includeMnemonic: true,
      walletConnectProjectId: "",
    });
    await reloaded.resume();

    expect(reloaded.current()?.address).toBe(account.addr.toString());
    expect(reloaded.current()?.walletName).toBe("dev wallet (mnemonic)");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("resume_resolves_signed_out_when_the_persisted_session_is_dead", async () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const prompt = vi
      .fn<() => string | null>()
      .mockReturnValueOnce(mnemonic)
      .mockReturnValue(null);
    vi.stubGlobal("prompt", prompt);
    await createWalletModule({
      includeMnemonic: true,
      walletConnectProjectId: "",
    }).connect("mnemonic");
    // The session record survives but its restore material is gone — the
    // same shape as a WalletConnect pairing the wallet app has dropped.
    localStorage.removeItem("@txnlab/use-wallet:v4_mnemonic");

    const reloaded = createWalletModule({
      includeMnemonic: true,
      walletConnectProjectId: "",
    });
    await expect(reloaded.resume()).resolves.toBeUndefined();
    expect(reloaded.current()).toBeNull();
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
      nickname: "arc60-player",
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
  const arc60Wallet: ConnectedWallet = {
    address,
    walletName: "arc60-capable",
    signTransactions: vi.fn(),
    signData,
  };
  const result = await loginWithWallet({
    // biome-ignore lint/suspicious/noExplicitAny: focused auth client double
    client: client as any,
    meta: { network: { caip2: "mock:local" } } as Meta,
    wallet: arc60Wallet,
  });
  expect(result.kind).toBe("signed-in");
  expect(signData).toHaveBeenCalledWith("e30=", {
    scope: 1,
    encoding: "base64",
  });
  expect(arc60Wallet.signTransactions).not.toHaveBeenCalled();
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
