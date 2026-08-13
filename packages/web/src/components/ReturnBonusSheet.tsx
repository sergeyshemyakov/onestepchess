import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import type { BonusSweepQuote } from "../api/schemas.js";
import { formatMicroAlgo, formatMicroUsdc } from "../lib/format.js";
import { useMeta } from "../meta/MetaContext.jsx";
import { loadWalletModule } from "../wallet/lazy.js";
import { PaymentWalletSheet } from "../wallet/PaymentWalletSheet.jsx";
import type { ConnectedWallet } from "../wallet/provider.js";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

function errorHint(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return cause.envelope.hint;
  if (cause instanceof Error && cause.name === "UnsafeSweepError") {
    return cause.message;
  }
  return fallback;
}

/** Confirmation sheet for returning an unspent welcome bonus: quote → confirm
 * → sign with the player's wallet → relay. The quote is server-built and
 * locally re-validated before the wallet ever sees it (same trust model as
 * the starter-stake opt-in). */
export function ReturnBonusSheet(props: {
  readonly client: ApiClient;
  readonly address: string;
  readonly onClose: () => void;
  readonly onReturned: () => void;
}) {
  const { meta } = useMeta();
  const [quote, setQuote] = useState<BonusSweepQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    "confirm" | "connect" | "working" | "done"
  >("confirm");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, props.onClose);
  const { client } = props;

  useEffect(() => {
    let cancelled = false;
    client
      .getBonusSweepTxns()
      .then((fetched) => {
        if (!cancelled) setQuote(fetched);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setQuoteError(
            errorHint(cause, "could not check the wallet — try again shortly"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const finish = useCallback(
    async (wallet: ConnectedWallet) => {
      if (quote === null || meta === null) return;
      setPhase("working");
      setError(null);
      try {
        const { signAndSubmitBonusSweep } = await import("../wallet/sweep.js");
        await signAndSubmitBonusSweep({
          client,
          quote,
          address: props.address,
          meta,
          getWallet: async () => wallet,
        });
        setPhase("done");
        props.onReturned();
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") {
          setPhase("confirm");
          return;
        }
        setError(errorHint(cause, "the return did not complete — try again"));
        setPhase("confirm");
      }
    },
    [client, meta, props, quote],
  );

  const confirm = useCallback(async () => {
    if (meta === null) return;
    setError(null);
    const module = await loadWalletModule(meta.network.caip2);
    const current = module.current();
    if (current?.address === props.address) {
      await finish(current);
      return;
    }
    if (current !== null) await module.disconnect().catch(() => undefined);
    setPhase("connect");
  }, [finish, meta, props.address]);

  if (phase === "connect" && meta !== null) {
    return (
      <PaymentWalletSheet
        address={props.address}
        caip2={meta.network.caip2}
        onConnected={(wallet) => void finish(wallet)}
        onCancel={() => setPhase("confirm")}
      />
    );
  }

  const usdc = quote?.txns.find((txn) => txn.leg === "usdc");
  const algo = quote?.txns.find((txn) => txn.leg === "algo");

  return (
    <div className="modalback">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="return welcome bonus"
        data-testid="return-bonus-sheet"
      >
        <h3>RETURN BONUS?</h3>
        {quote === null ? (
          quoteError === null ? (
            <p className="console">&gt; checking the wallet…</p>
          ) : (
            <p className="formerr" role="alert">
              {quoteError}
            </p>
          )
        ) : quote.txns.length === 0 ? (
          <p className="sub">
            nothing left to return — the wallet is already at its minimum
            balance.
          </p>
        ) : phase === "done" ? (
          <>
            <p className="sub">
              returned to the bonus pool — thanks for trying One Step Chess.
            </p>
            <div className="walletbox">
              <h4>RETURNED</h4>
              <p className="console" data-testid="return-bonus-done">
                {usdc !== undefined
                  ? `${formatMicroUsdc(usdc.amount)} USDC`
                  : null}
                {usdc !== undefined && algo !== undefined ? " · " : null}
                {algo !== undefined ? formatMicroAlgo(algo.amount) : null}
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="sub">
              send the unspent welcome bonus back so another player can use it.
              your wallet stays yours — this only moves the balances below.
            </p>
            <div className="walletbox">
              <h4>TO RETURN</h4>
              <p className="console" data-testid="return-bonus-amounts">
                {usdc !== undefined
                  ? `${formatMicroUsdc(usdc.amount)} USDC`
                  : null}
                {usdc !== undefined && algo !== undefined ? " · " : null}
                {algo !== undefined ? formatMicroAlgo(algo.amount) : null}
              </p>
            </div>
            <p className="faintt">
              a small network fee is deducted; the rest of the ALGO stays as the
              account minimum the network requires.
            </p>
          </>
        )}
        {phase === "working" ? (
          <p className="console" role="status">
            &gt; sign in your wallet, then relaying…
          </p>
        ) : null}
        {error === null ? null : (
          <p className="formerr" role="alert">
            {error}
          </p>
        )}
        {quote !== null && quote.txns.length > 0 && phase !== "done" ? (
          <div className="modal-actions pair">
            <button
              type="button"
              className="btn pri mini"
              disabled={phase === "working" || meta === null}
              onClick={() => void confirm()}
            >
              Y — return it
            </button>
            <button
              type="button"
              className="btn mini"
              disabled={phase === "working"}
              onClick={props.onClose}
            >
              N — keep playing
            </button>
          </div>
        ) : (
          <div className="modal-actions single">
            <button type="button" className="btn mini" onClick={props.onClose}>
              ← close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
