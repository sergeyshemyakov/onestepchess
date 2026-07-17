import { useCallback, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { useSession } from "../auth/SessionContext.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { ClaimBar } from "../components/ClaimBar.jsx";
import { shortenAddress } from "../lib/address.js";
import { formatMicroUsdc } from "../lib/format.js";
import { PlayView } from "../play/PlayView.jsx";
import { usePlayFlow } from "../play/usePlayFlow.js";
import { playCtaState } from "./hubCta.js";

/** Minimal logged-in hub (release plan §3.2): PLAY + DEMO PLAY with printed
 * explanations from `/meta.economics`, the morphing play surface over it.
 * Panes/archive/stats arrive in Release 2. */
export function Hub(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly player: PlayerView;
}) {
  const { logout } = useSession();
  const flow = usePlayFlow({
    client: props.client,
    meta: props.meta,
    address: props.player.address,
    enabled: true,
  });
  const [surfaceHidden, setSurfaceHidden] = useState(false);
  const { state } = flow;

  const claimOpen =
    state.phase === "FOCUS" ||
    state.phase === "CONFIRM" ||
    state.phase === "SIGNING" ||
    state.phase === "SETTLING";
  const paused = props.meta.status.mode === "paused";
  const cta = playCtaState({
    phase: state.phase,
    paused,
    ...(state.retryAfterSeconds === undefined
      ? {}
      : { quotaRetryAfterSeconds: state.retryAfterSeconds }),
  });

  const stake = props.meta.economics.humanStakeMicroUsdc;
  const payout = stake * props.meta.economics.humanTargetMult;

  const start = useCallback(
    (demo: boolean) => {
      setSurfaceHidden(false);
      flow.send({ type: "PLAY", demo });
    },
    [flow],
  );

  const surfaceVisible = state.phase !== "IDLE" && !surfaceHidden;
  const claimBar = useMemo(() => {
    if (!claimOpen || surfaceVisible || state.claim === undefined) return null;
    return (
      <ClaimBar
        deadline={state.claim.deadline}
        onReturn={() => setSurfaceHidden(false)}
      />
    );
  }, [claimOpen, surfaceVisible, state.claim]);

  return (
    <AppShell
      topRight={
        <>
          <span className="chip click" title={props.player.address}>
            {props.player.nickname} · {shortenAddress(props.player.address)}
          </span>
          <button
            type="button"
            className="btn mini"
            onClick={() => void logout()}
          >
            log out
          </button>
        </>
      }
      belowBar={claimBar}
    >
      <div className={surfaceVisible && claimOpen ? "focus-dim" : ""}>
        <div className="hubplay">
          <button
            type="button"
            className="bigplay"
            disabled={cta.disabled}
            onClick={() => (claimOpen ? setSurfaceHidden(false) : start(false))}
          >
            <span className="bp-title">▸ PLAY</span>
            <span className="bp-sub">
              {formatMicroUsdc(stake)} on one move in a live game — win pays{" "}
              {formatMicroUsdc(payout)}
            </span>
          </button>
          {cta.reason !== null ? (
            <button
              type="button"
              className="ctareason btn mini"
              onClick={() => setSurfaceHidden(false)}
            >
              {cta.reason}
            </button>
          ) : null}
          <button
            type="button"
            className="bigplay demo"
            disabled={cta.disabled}
            onClick={() => (claimOpen ? setSurfaceHidden(false) : start(true))}
          >
            <span className="bp-title">▸ DEMO PLAY</span>
            <span className="bp-sub">
              $0 — same live games · no stats · no replay
            </span>
          </button>
          {state.phase === "IDLE" ? (
            <div className="empty" style={{ marginTop: 18, maxWidth: 420 }}>
              <span className="vt">[ NO SIGNAL ]</span>
              your first board is one <span className="win">PLAY</span> away.
            </div>
          ) : null}
        </div>
      </div>
      {surfaceVisible ? (
        <>
          {claimOpen ? (
            <p style={{ padding: "0 22px", textAlign: "right" }}>
              <button
                type="button"
                className="btn mini"
                onClick={() => setSurfaceHidden(true)}
              >
                ▾ hub
              </button>
            </p>
          ) : null}
          <PlayView flow={flow} meta={props.meta} />
        </>
      ) : null}
    </AppShell>
  );
}
