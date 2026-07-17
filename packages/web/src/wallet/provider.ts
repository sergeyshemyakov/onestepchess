// The lazy wallet subtree (§5.6): use-wallet + wallet SDKs + algosdk enter
// the bundle only through this chunk, dynamically imported on first wallet
// intent. Release 1 develops against use-wallet's Mnemonic provider
// (release plan §9 decision 1). Branded wallets are deliberately absent from
// this Release-1 list until their Release-2 certification is complete.

import { NetworkId, WalletId, WalletManager } from "@txnlab/use-wallet-react";
import algosdk from "algosdk";

const MNEMONIC_STORAGE_KEY = "@txnlab/use-wallet:v4_mnemonic";

function normalizeMnemonic(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isValidMnemonic(value: string): boolean {
  try {
    algosdk.mnemonicToSecretKey(value);
    return true;
  } catch {
    return false;
  }
}

function removeInvalidPersistedMnemonic(): void {
  try {
    const persisted = localStorage.getItem(MNEMONIC_STORAGE_KEY);
    if (persisted !== null && !isValidMnemonic(persisted)) {
      localStorage.removeItem(MNEMONIC_STORAGE_KEY);
    }
  } catch {
    // Storage may be unavailable in locked-down browser contexts. The wallet
    // provider will still surface its normal connection error in that case.
  }
}

export async function promptForValidMnemonic(
  promptForInput: (message: string) => string | null = window.prompt.bind(
    window,
  ),
): Promise<string> {
  let invalid = false;
  while (true) {
    const entered = promptForInput(
      invalid
        ? "That mnemonic is invalid. Enter a valid 25-word mnemonic passphrase:"
        : "Enter 25-word mnemonic passphrase:",
    );
    if (entered === null) {
      const cancelled = new Error("mnemonic entry cancelled");
      cancelled.name = "AbortError";
      throw cancelled;
    }
    const mnemonic = normalizeMnemonic(entered);
    if (isValidMnemonic(mnemonic)) return mnemonic;
    invalid = true;
  }
}

export type WalletChoice = {
  readonly id: string;
  readonly name: string;
};

export type ConnectedWallet = {
  readonly address: string;
  readonly walletName: string;
  readonly signTransactions: (
    txns: readonly algosdk.Transaction[],
  ) => Promise<Uint8Array>;
  /** ARC-60 branch — present only when the wallet supports signData
   * (currently Lute); the fallback-txn path is used otherwise (F-W2). */
  readonly signData?: (
    dataB64: string,
    metadata: { readonly scope: number; readonly encoding: string },
  ) => Promise<{
    readonly signatureB64: string;
    readonly authenticatorDataB64: string;
  }>;
};

export type WalletModule = {
  readonly listWallets: () => readonly WalletChoice[];
  readonly connect: (id: string) => Promise<ConnectedWallet>;
  readonly disconnect: () => Promise<void>;
};

export function createWalletModule(): WalletModule {
  // use-wallet persists the prompt result before deriving the account. Clean
  // up invalid values left by earlier builds so the prompt can open again.
  removeInvalidPersistedMnemonic();
  const manager = new WalletManager({
    wallets: [
      {
        id: WalletId.MNEMONIC,
        options: {
          persistToStorage: true,
          promptForMnemonic: promptForValidMnemonic,
        },
      },
    ],
    defaultNetwork: NetworkId.LOCALNET,
  });

  const names: Record<string, string> = {
    [WalletId.MNEMONIC]: "dev wallet (mnemonic)",
  };

  return {
    listWallets: () =>
      manager.wallets.map((wallet) => ({
        id: wallet.id,
        name: names[wallet.id] ?? wallet.metadata.name,
      })),

    async connect(id) {
      const wallet = manager.wallets.find((candidate) => candidate.id === id);
      if (wallet === undefined) throw new Error(`unknown wallet: ${id}`);
      const accounts = await wallet.connect();
      const address = wallet.activeAccount?.address ?? accounts[0]?.address;
      if (address === undefined) throw new Error("wallet connected no account");
      return {
        address,
        walletName: names[wallet.id] ?? wallet.metadata.name,
        signTransactions: async (txns) => {
          const signed = await wallet.signTransactions([...txns]);
          const bytes = signed.find((entry) => entry !== null);
          if (bytes === null || bytes === undefined) {
            throw new Error("wallet returned no signature");
          }
          return bytes;
        },
      };
    },

    async disconnect() {
      const active = manager.activeWallet;
      if (active !== null) await active.disconnect();
    },
  };
}
