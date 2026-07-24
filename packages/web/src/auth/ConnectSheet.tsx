import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { useDialogFocusTrap } from "../components/useDialogFocusTrap.js";
import { readRef } from "../lib/storage.js";
import { loadWalletModule } from "../wallet/lazy.js";
import type { WalletChoice, WalletModule } from "../wallet/provider.js";
import { loginWithWallet, type PendingRegistration } from "./login.js";
import { RegistrationModal } from "./RegistrationModal.jsx";

/** Door 1: the connect sheet. Opening it is the first wallet intent — the
 * wallet chunk loads here, never before (§5.6). Wallet-reject at any step
 * closes back to the landing with no state change (F-W2). */
export function ConnectSheet(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly onSignedIn: (player: PlayerView, linkedGuestClaims?: number) => void;
  readonly onClose: () => void;
}) {
  const [wallets, setWallets] = useState<readonly WalletChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRegistration | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { client, meta, onSignedIn, onClose } = props;
  useDialogFocusTrap(dialogRef, onClose);

  useEffect(() => {
    let cancelled = false;
    loadWalletModule()
      .then((module) => {
        if (!cancelled) setWallets(module.listWallets());
      })
      .catch(() => {
        if (!cancelled) setError("wallet support failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      let module: WalletModule | null = null;
      try {
        module = await loadWalletModule();
        const wallet = await module.connect(id);
        const ref = readRef();
        const outcome = await loginWithWallet({
          client,
          meta,
          wallet,
          ...(ref === null ? {} : { ref }),
        });
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
            setError(outcome.message);
            return;
        }
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") {
          onClose();
          return;
        }
        await module?.disconnect().catch(() => undefined);
        setError(
          "wallet sign-in failed — check your wallet connection, then try again",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, client, meta, onClose, onSignedIn],
  );

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
