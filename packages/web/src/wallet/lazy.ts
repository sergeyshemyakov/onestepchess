// Loader boundary for the wallet subtree (§5.6): use-wallet, wallet SDKs and
// algosdk load through dynamic import on first wallet intent, never in the
// root bundle. This module itself has no static wallet imports.

import type { WalletModule } from "./provider.js";

let loaded: Promise<WalletModule> | null = null;

export function loadWalletModule(): Promise<WalletModule> {
  // Pera and Defly still transitively load WalletConnect v1 code that expects
  // the Node-style alias even though the SDK is running in a browser.
  const runtime = globalThis as typeof globalThis & {
    global?: typeof globalThis;
  };
  runtime.global ??= globalThis;
  loaded ??= import("./provider.js").then((module) =>
    module.createWalletModule(),
  );
  return loaded;
}

/** Logout must disconnect the wallet — but only when the chunk ever loaded;
 * a session drop never pulls wallet code in by itself. */
export async function disconnectWalletIfLoaded(): Promise<void> {
  if (loaded === null) return;
  const module = await loaded;
  await module.disconnect();
}

export function resetWalletModuleForTests(): void {
  loaded = null;
}
