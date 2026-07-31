// The wallet subtree stays behind the first wallet intent so anonymous demo
// visitors do not download wallet SDKs. Mnemonic remains development-only;
// production offers the certified branded providers.

import {
  NetworkId,
  ScopeType,
  type SupportedWallet,
  WalletId,
  WalletManager,
} from "@txnlab/use-wallet-react";
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

export type WalletModuleOptions = {
  readonly walletConnectProjectId?: string;
  readonly includeMnemonic?: boolean;
};

type ConnectableWallet<Account> = {
  readonly connect: () => Promise<readonly Account[]>;
  readonly disconnect: () => Promise<void>;
};

function cancellationType(cause: unknown): string | null {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("data" in cause) ||
    typeof cause.data !== "object" ||
    cause.data === null ||
    !("type" in cause.data) ||
    typeof cause.data.type !== "string"
  ) {
    return null;
  }
  return cause.data.type;
}

function isConnectCancellation(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === "AbortError") return true;
  const type = cancellationType(cause);
  return (
    type === "OPERATION_CANCELLED" ||
    type === "CONNECT_MODAL_CLOSED" ||
    type === "CONNECT_CANCELLED"
  );
}

function abortFrom(cause: unknown): Error {
  const error = new Error("wallet connection cancelled", { cause });
  error.name = "AbortError";
  return error;
}

/** Pera/WalletConnect can leave a stale persisted session after an interrupted
 * handoff. The old UI cleaned it only after surfacing an error, making the
 * user's second click succeed. Recover once within the original click. */
export async function connectWithStaleSessionRecovery<Account>(
  wallet: ConnectableWallet<Account>,
  recoverStaleSession: boolean,
): Promise<readonly Account[]> {
  try {
    return await wallet.connect();
  } catch (cause) {
    if (isConnectCancellation(cause)) throw abortFrom(cause);
    if (!recoverStaleSession) throw cause;
    await wallet.disconnect().catch(() => undefined);
  }

  try {
    return await wallet.connect();
  } catch (cause) {
    if (isConnectCancellation(cause)) throw abortFrom(cause);
    throw cause;
  }
}

export function createWalletModule(
  options: WalletModuleOptions = {},
): WalletModule {
  // use-wallet persists the prompt result before deriving the account. Clean
  // up invalid values left by earlier builds so the prompt can open again.
  removeInvalidPersistedMnemonic();
  const walletConnectProjectId =
    options.walletConnectProjectId ??
    import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
  const includeMnemonic = options.includeMnemonic ?? import.meta.env.DEV;
  const wallets: SupportedWallet[] = [
    WalletId.PERA,
    WalletId.DEFLY,
    { id: WalletId.LUTE, options: { siteName: "One Step Chess" } },
  ];
  if (
    walletConnectProjectId !== undefined &&
    walletConnectProjectId.trim() !== ""
  ) {
    wallets.push({
      id: WalletId.WALLETCONNECT,
      options: {
        projectId: walletConnectProjectId,
        enableExplorer: true,
        explorerRecommendedWalletIds: [],
        privacyPolicyUrl: window.location.origin,
        termsOfServiceUrl: window.location.origin,
        themeMode: "dark",
        themeVariables: {},
      },
    });
  }
  if (includeMnemonic) {
    wallets.push({
      id: WalletId.MNEMONIC,
      options: {
        persistToStorage: true,
        promptForMnemonic: promptForValidMnemonic,
      },
    });
  }
  const manager = new WalletManager({
    wallets: wallets as [SupportedWallet, ...SupportedWallet[]],
    // The fallback auth artifact uses the mainnet genesis profile even in
    // mock deployments so real wallet apps can render it consistently.
    defaultNetwork: includeMnemonic ? NetworkId.LOCALNET : NetworkId.MAINNET,
  });

  const names: Record<string, string> = {
    [WalletId.PERA]: "Pera",
    [WalletId.DEFLY]: "Defly",
    [WalletId.LUTE]: "Lute",
    [WalletId.WALLETCONNECT]: "WalletConnect",
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
      await manager.setActiveNetwork(
        id === WalletId.MNEMONIC ? NetworkId.LOCALNET : NetworkId.MAINNET,
      );
      const accounts = await connectWithStaleSessionRecovery(
        wallet,
        id === WalletId.PERA,
      );
      const address = wallet.activeAccount?.address ?? accounts[0]?.address;
      if (address === undefined) throw new Error("wallet connected no account");
      const signData = wallet.canSignData
        ? async (
            dataB64: string,
            metadata: { readonly scope: number; readonly encoding: string },
          ) => {
            if (metadata.scope !== ScopeType.AUTH) {
              throw new Error("wallet auth metadata has an unsupported scope");
            }
            const signed = await wallet.signData(dataB64, {
              scope: ScopeType.AUTH,
              encoding: metadata.encoding,
            });
            return {
              signatureB64: bytesToBase64(signed.signature),
              authenticatorDataB64: bytesToBase64(signed.authenticatorData),
            };
          }
        : undefined;
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
        ...(signData === undefined ? {} : { signData }),
      };
    },

    async disconnect() {
      const active = manager.activeWallet;
      if (active !== null) await active.disconnect();
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
