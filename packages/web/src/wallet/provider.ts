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

/** Shown by Lute as the requesting site in its connect/sign popups. */
const LUTE_SITE_NAME = "One Step Chess";

// Client mirror of the server's genesis→network map (server/src/auth/genesis.ts).
// The branded wallets (Pera/Defly/…) enforce their own selected network at
// connect time, so the deployment's CAIP-2 — not a hardcoded MAINNET — decides
// which network they are asked for; otherwise a testnet wallet reports a
// network mismatch before signing is ever attempted.
const MAINNET_GENESIS_HASH_B64 = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const TESTNET_GENESIS_HASH_B64 = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

export function networkIdForCaip2(caip2: string): NetworkId {
  // `mock:local` keeps the mainnet profile so the never-submitted fallback auth
  // artifact renders consistently in real wallet apps (§6.3).
  if (caip2 === "mock:local") return NetworkId.MAINNET;
  if (caip2.startsWith("algorand:")) {
    const reference = caip2.slice("algorand:".length);
    if (
      reference.length > 0 &&
      TESTNET_GENESIS_HASH_B64.startsWith(reference)
    ) {
      return NetworkId.TESTNET;
    }
    if (
      reference.length > 0 &&
      MAINNET_GENESIS_HASH_B64.startsWith(reference)
    ) {
      return NetworkId.MAINNET;
    }
  }
  throw new Error(`unsupported CAIP-2 network: ${caip2}`);
}

/** Numeric Algorand chain id the Pera/Defly WalletConnect SDKs expect. Unlike
 * the generic WalletConnect wallet, use-wallet builds these clients from their
 * static registration options and never forwards the active network, and the
 * SDKs default to 4160 which they map to mainnet — so a testnet Pera app
 * rejects the sign request (SIGN_TXN_NETWORK_MISMATCH). Baking the deployment's
 * chain id into the wallet options is the only way to reach them. */
export function brandedWalletChainId(caip2: string): 416001 | 416002 | 416003 {
  switch (networkIdForCaip2(caip2)) {
    case NetworkId.TESTNET:
      return 416002;
    case NetworkId.BETANET:
      return 416003;
    default:
      return 416001;
  }
}

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
    indexesToSign?: readonly number[],
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
  readonly current: () => ConnectedWallet | null;
  readonly disconnect: () => Promise<void>;
  /** Silently restores the active wallet session use-wallet persisted in a
   * previous page load, so a reload does not force a fresh pairing just to
   * sign. Resolves signed-out when there is nothing to resume or the persisted
   * session is dead. */
  readonly resume: () => Promise<void>;
};

export type WalletModuleOptions = {
  readonly walletConnectProjectId?: string;
  readonly includeMnemonic?: boolean;
  /** The deployment's CAIP-2 network (`meta.network.caip2`). Drives which
   * network the branded wallets connect on. Defaults to the mock/mainnet
   * profile when absent. */
  readonly caip2?: string;
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

/** The WalletConnect-based wallets (Pera, Defly, generic WalletConnect) can
 * leave a stale persisted session after an interrupted handoff. The old UI
 * cleaned it only after surfacing an error, making the user's second click
 * succeed. Recover once within the original click. */
export function recoversStaleSession(id: string): boolean {
  return (
    id === WalletId.PERA ||
    id === WalletId.DEFLY ||
    id === WalletId.WALLETCONNECT
  );
}

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

/** use-wallet 4.x still speaks the lute-connect v1 signData wire protocol
 * (a bare base64 payload), but lute.app now implements v2, which expects the
 * dApp-built StdSignData object — a v1-shaped message leaves the lute.app/auth
 * popup blank. Drive lute-connect directly for this one step; connect and
 * signTransactions kept the v1 shape, so use-wallet still handles those. */
export function createLuteSignData(
  address: string,
  siteName: string,
): NonNullable<ConnectedWallet["signData"]> {
  return async (dataB64, metadata) => {
    if (metadata.scope !== ScopeType.AUTH) {
      throw new Error("wallet auth metadata has an unsupported scope");
    }
    const { default: LuteConnect, ScopeType: LuteScope } = await import(
      "lute-connect"
    );
    const client = new LuteConnect(siteName);
    const domain = window.location.host;
    const authenticatorData = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain)),
    );
    const response = await client.signData(
      {
        data: dataB64,
        signer: algosdk.decodeAddress(address).publicKey,
        domain,
        authenticatorData,
      },
      { scope: LuteScope.AUTH, encoding: metadata.encoding },
    );
    return {
      signatureB64: bytesToBase64(response.signature),
      authenticatorDataB64: bytesToBase64(response.authenticatorData),
    };
  };
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
  const caip2 = options.caip2 ?? "mock:local";
  const network = networkIdForCaip2(caip2);
  const chainId = brandedWalletChainId(caip2);
  const wallets: SupportedWallet[] = [
    { id: WalletId.PERA, options: { chainId } },
    { id: WalletId.DEFLY, options: { chainId } },
    // Lute is not WalletConnect-based: it derives the network from the active
    // algod client, so it takes no chainId and needs no stale-session recovery.
    { id: WalletId.LUTE, options: { siteName: LUTE_SITE_NAME } },
  ];
  if (
    walletConnectProjectId !== undefined &&
    walletConnectProjectId.trim() !== ""
  ) {
    wallets.push({
      id: WalletId.WALLETCONNECT,
      options: {
        projectId: walletConnectProjectId,
        // The explorer wallet-list calls api.web3modal.org, which the server
        // CSP's connect-src does not allow; the QR pairing path works without
        // it. Allowlist those origins before ever re-enabling this.
        enableExplorer: false,
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
    defaultNetwork: includeMnemonic ? NetworkId.LOCALNET : network,
  });

  const names: Record<string, string> = {
    [WalletId.PERA]: "Pera",
    [WalletId.DEFLY]: "Defly",
    [WalletId.LUTE]: "Lute",
    [WalletId.WALLETCONNECT]: "WalletConnect",
    [WalletId.MNEMONIC]: "dev wallet (mnemonic)",
  };

  let connected: ConnectedWallet | null = null;

  function connectedWallet(
    wallet: (typeof manager.wallets)[number],
    address: string,
  ): ConnectedWallet {
    const signData =
      wallet.id === WalletId.LUTE
        ? createLuteSignData(address, LUTE_SITE_NAME)
        : wallet.canSignData
          ? async (
              dataB64: string,
              metadata: { readonly scope: number; readonly encoding: string },
            ) => {
              if (metadata.scope !== ScopeType.AUTH) {
                throw new Error(
                  "wallet auth metadata has an unsupported scope",
                );
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
      signTransactions: async (txns, indexesToSign) => {
        const signed = await wallet.signTransactions(
          [...txns],
          indexesToSign === undefined ? undefined : [...indexesToSign],
        );
        const bytes = signed.find((entry) => entry !== null);
        if (bytes === null || bytes === undefined) {
          throw new Error("wallet returned no signature");
        }
        return bytes;
      },
      ...(signData === undefined ? {} : { signData }),
    };
  }

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
        id === WalletId.MNEMONIC ? NetworkId.LOCALNET : network,
      );
      const accounts = await connectWithStaleSessionRecovery(
        wallet,
        recoversStaleSession(id),
      );
      const address = wallet.activeAccount?.address ?? accounts[0]?.address;
      if (address === undefined) throw new Error("wallet connected no account");
      connected = connectedWallet(wallet, address);
      return connected;
    },

    current: () => connected,

    async resume() {
      const persistedActive = manager.activeWallet;
      if (persistedActive === null) return;
      try {
        // use-wallet can retain several historical wallet sessions, but this
        // app needs only the active one. Resuming all of them lets a dead,
        // inactive pairing reject the aggregate operation and mask a healthy
        // active session.
        await persistedActive.resumeSession();
      } catch {
        // A dead persisted session (e.g. a pairing the wallet app dropped)
        // must not block wallet loading — the user reconnects manually.
        return;
      }
      const active = manager.activeWallet;
      const address = active?.activeAccount?.address;
      if (active !== null && address !== undefined) {
        connected = connectedWallet(active, address);
      }
    },

    async disconnect() {
      const active = manager.activeWallet;
      if (active !== null) await active.disconnect();
      connected = null;
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
