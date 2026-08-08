import { useCallback, useEffect, useRef, useState } from "react";
import { useDialogFocusTrap } from "../components/useDialogFocusTrap.js";
import { loadWalletModule } from "./lazy.js";
import type { ConnectedWallet, WalletChoice } from "./provider.js";

export function PaymentWalletSheet(props: {
  readonly address: string;
  /** Deployment CAIP-2 network — selects which network the wallet connects on. */
  readonly caip2: string;
  readonly onConnected: (wallet: ConnectedWallet) => void;
  readonly onCancel: () => void;
}) {
  const [wallets, setWallets] = useState<readonly WalletChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { onCancel } = props;
  useDialogFocusTrap(dialogRef, onCancel);

  useEffect(() => {
    let cancelled = false;
    loadWalletModule(props.caip2)
      .then((module) => {
        if (!cancelled) setWallets(module.listWallets());
      })
      .catch(() => {
        if (!cancelled) setError("wallet support failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [props.caip2]);

  const connect = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const module = await loadWalletModule(props.caip2);
        const wallet = await module.connect(id);
        if (wallet.address !== props.address) {
          await module.disconnect().catch(() => undefined);
          setError(
            `reconnect the wallet used for this account: ${props.address}`,
          );
          return;
        }
        props.onConnected(wallet);
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") {
          props.onCancel();
          return;
        }
        setError("wallet connection failed — try again");
      } finally {
        setBusy(false);
      }
    },
    [busy, props],
  );

  return (
    <div className="modalback">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="reconnect wallet"
      >
        <h3>RECONNECT WALLET</h3>
        <p className="sub">use the wallet for this signed-in account.</p>
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
                  onClick={() => connect(wallet.id)}
                >
                  ▸ {wallet.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {error === null ? null : (
          <p className="formerr" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions single">
          <button type="button" className="btn mini" onClick={props.onCancel}>
            ← back
          </button>
        </div>
      </div>
    </div>
  );
}
