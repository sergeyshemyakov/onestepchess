import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { loadWalletModule } from "../wallet/lazy.js";
import type { WalletChoice } from "../wallet/provider.js";
import { loginWithWallet, type PendingRegistration } from "./login.js";
import { RegistrationModal } from "./RegistrationModal.jsx";

/** Door 1: the connect sheet. Opening it is the first wallet intent — the
 * wallet chunk loads here, never before (§5.6). Wallet-reject at any step
 * closes back to the landing with no state change (F-W2). */
export function ConnectSheet(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly onSignedIn: (player: PlayerView) => void;
  readonly onClose: () => void;
}) {
  const [wallets, setWallets] = useState<readonly WalletChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRegistration | null>(null);

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
      try {
        const module = await loadWalletModule();
        const wallet = await module.connect(id);
        const outcome = await loginWithWallet({
          client: props.client,
          meta: props.meta,
          wallet,
        });
        switch (outcome.kind) {
          case "signed-in":
            props.onSignedIn(outcome.player);
            return;
          case "registration-required":
            setPending(outcome.pending);
            return;
          case "rejected":
            props.onClose();
            return;
          case "error":
            setError(outcome.message);
            return;
        }
      } catch {
        // connect itself rejected/failed — landing unchanged
        props.onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, props],
  );

  if (pending !== null) {
    return (
      <RegistrationModal
        client={props.client}
        meta={props.meta}
        pending={pending}
        onRegistered={props.onSignedIn}
        onCancel={props.onClose}
      />
    );
  }

  return (
    <div className="modalback">
      <div
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
        <p className="esc">
          <button type="button" onClick={props.onClose}>
            ← back
          </button>
        </p>
      </div>
    </div>
  );
}
