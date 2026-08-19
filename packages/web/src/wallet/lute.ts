// Shared by the login and payment sheets. Deliberately a leaf module: pulling
// these from provider.ts would drag the wallet SDK chunk into the root bundle
// (§5.6).

/** use-wallet's WalletId.LUTE, inlined to keep the SDK out of this chunk. */
export const LUTE_WALLET_ID = "lute";

/** Lute opens its connect/sign windows via window.open, which popup blockers
 * eat silently — lute-connect then waits forever with no error. Every Lute
 * click pushes the matching hint so a blocked popup is diagnosable. */
export const LUTE_CONNECT_POPUP_HINT =
  "Lute opens in a popup — if nothing appears, check your browser's popup blocker";
export const LUTE_SIGN_POPUP_HINT =
  "Lute asks for the signature in a popup — if nothing appears, check your browser's popup blocker";
