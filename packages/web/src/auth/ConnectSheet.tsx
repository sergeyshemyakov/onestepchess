import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { useToasts } from "../components/Toasts.jsx";
import { useDialogFocusTrap } from "../components/useDialogFocusTrap.js";
import { shortenAddress } from "../lib/address.js";
import { readRef } from "../lib/storage.js";
import { loadWalletModule } from "../wallet/lazy.js";
import {
  LUTE_CONNECT_POPUP_HINT,
  LUTE_SIGN_POPUP_HINT,
  LUTE_WALLET_ID,
} from "../wallet/lute.js";
import type {
  ConnectedWallet,
  WalletChoice,
  WalletModule,
} from "../wallet/provider.js";
import { loginWithWallet, type PendingRegistration } from "./login.js";
import { RegistrationModal } from "./RegistrationModal.jsx";

/** Door 1: the connect sheet. Opening it is the first wallet intent — the
 * wallet chunk loads here, never before (§5.6). Wallet-reject at any step
 * closes back to the landing with no state change (F-W2). */
export function ConnectSheet(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  /** Quick-setup path: lute.app just opened in a new tab, so the sheet
   * offers a single Lute connect instead of the wallet list. */
  readonly lutePrompt?: boolean;
  readonly onSignedIn: (player: PlayerView, linkedGuestClaims?: number) => void;
  readonly onClose: () => void;
}) {
  const [wallets, setWallets] = useState<readonly WalletChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [walletConnected, setWalletConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRegistration | null>(null);
  /** Lute connected, sign-in not yet started — see the pause in pick(). */
  const [luteWallet, setLuteWallet] = useState<ConnectedWallet | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { client, meta, onSignedIn } = props;
  const { push } = useToasts();
  /** Set when the user backs out of the sheet. An in-flight login cannot be
   * aborted mid-wallet, so its late outcome is discarded instead — backing
   * out must never turn into a surprise sign-in. */
  const closedRef = useRef(false);
  const { onClose: closeProp } = props;
  const onClose = useCallback(() => {
    closedRef.current = true;
    closeProp();
  }, [closeProp]);
  useDialogFocusTrap(dialogRef, onClose);

  useEffect(() => {
    let cancelled = false;
    loadWalletModule(meta.network.caip2)
      .then((module) => {
        if (!cancelled) setWallets(module.listWallets());
      })
      .catch(() => {
        if (!cancelled) setError("wallet support failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [meta.network.caip2]);

  const finishLogin = useCallback(
    async (wallet: ConnectedWallet) => {
      setWalletConnected(true);
      const ref = readRef();
      const outcome = await loginWithWallet({
        client,
        meta,
        wallet,
        ...(ref === null ? {} : { ref }),
      });
      if (closedRef.current) return;
      switch (outcome.kind) {
        case "signed-in":
          onSignedIn(outcome.player, outcome.linkedGuestClaims);
          return;
        case "registration-required":
          setPending(outcome.pending);
          return;
        case "rejected":
          onClose();
          return;
        case "error":
          setWalletConnected(false);
          setError(outcome.message);
          return;
      }
    },
    [client, meta, onClose, onSignedIn],
  );

  const failLogin = useCallback(
    async (cause: unknown, module: WalletModule | null) => {
      if (closedRef.current) return;
      if (cause instanceof Error && cause.name === "AbortError") {
        onClose();
        return;
      }
      await module?.disconnect().catch(() => undefined);
      setLuteWallet(null);
      setWalletConnected(false);
      // A server rejection (rate limit, invalid address, …) carries its own
      // hint — blaming the wallet for it sends the user down the wrong path.
      setError(
        cause instanceof ApiError
          ? cause.envelope.hint
          : "wallet sign-in failed — check your wallet connection, then try again",
      );
    },
    [onClose],
  );

  const pick = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      if (id === LUTE_WALLET_ID) push(LUTE_CONNECT_POPUP_HINT);
      let module: WalletModule | null = null;
      try {
        module = await loadWalletModule(meta.network.caip2);
        const wallet = await module.connect(id);
        if (id === LUTE_WALLET_ID) {
          // Lute signs in a popup it opens with window.open. The connect
          // popup already spent this click's popup allowance (and choosing
          // an account outlives the transient activation), so signing
          // immediately gets the popup silently blocked — lute-connect then
          // hangs forever. Pause for a fresh click before signing.
          setLuteWallet(wallet);
          return;
        }
        await finishLogin(wallet);
      } catch (cause) {
        await failLogin(cause, module);
      } finally {
        setBusy(false);
      }
    },
    [busy, failLogin, finishLogin, meta.network.caip2, push],
  );

  const luteSignIn = useCallback(async () => {
    if (busy || luteWallet === null) return;
    setBusy(true);
    setError(null);
    push(LUTE_SIGN_POPUP_HINT);
    let module: WalletModule | null = null;
    try {
      module = await loadWalletModule(meta.network.caip2);
      await finishLogin(luteWallet);
    } catch (cause) {
      await failLogin(cause, module);
    } finally {
      setBusy(false);
    }
  }, [busy, failLogin, finishLogin, luteWallet, meta.network.caip2, push]);

  if (pending !== null) {
    return (
      <RegistrationModal
        client={client}
        meta={meta}
        pending={pending}
        onRegistered={(response) =>
          onSignedIn(response.player, response.linkedGuestClaims)
        }
        onCancel={onClose}
      />
    );
  }

  return (
    <div className="modalback">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="connect wallet"
      >
        {walletConnected ? (
          <>
            <h3>CONNECT</h3>
            <p className="console">
              &gt; approve the sign-in request in your wallet
              {"\n"}&gt; nothing is broadcast — this can take a moment
            </p>
          </>
        ) : luteWallet !== null ? (
          <>
            <h3>{props.lutePrompt === true ? "QUICK SETUP" : "CONNECT"}</h3>
            <p className="console">
              &gt; Lute connected :: {shortenAddress(luteWallet.address)}
              {"\n"}&gt; one free signature logs you in — nothing is broadcast
            </p>
            <p className="lutecta">
              <button
                type="button"
                className="btn pri sheetbtn pulse-soft"
                disabled={busy}
                onClick={() => void luteSignIn()}
              >
                ▸ SIGN IN
              </button>
            </p>
          </>
        ) : props.lutePrompt === true ? (
          <>
            <h3>QUICK SETUP</h3>
            <p className="console">
              &gt; create a new Lute wallet and connect
              {"\n"}&gt; e.g. 25-word legacy
            </p>
            <p className="lutecta">
              <button
                type="button"
                className="btn pri sheetbtn"
                disabled={busy}
                onClick={() => pick(LUTE_WALLET_ID)}
              >
                ▸ CONNECT WITH LUTE
              </button>
            </p>
          </>
        ) : (
          <>
            <h3>CONNECT</h3>
            <p className="sub">one free signature — nothing is broadcast.</p>
            {wallets === null ? (
              <p className="console">&gt; loading wallet support…</p>
            ) : (
              <div className="walletbox">
                <h4>WALLETS</h4>
                <div
                  className="act"
                  style={{ flexDirection: "column", alignItems: "stretch" }}
                >
                  {wallets.map((wallet) => (
                    <button
                      key={wallet.id}
                      type="button"
                      className="btn mini"
                      disabled={busy}
                      onClick={() => pick(wallet.id)}
                    >
                      ▸ {wallet.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {error !== null ? (
          <p className="formerr" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions single">
          <button type="button" className="btn mini" onClick={onClose}>
            ← back
          </button>
        </div>
      </div>
    </div>
  );
}
