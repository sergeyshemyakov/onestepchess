import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { ConnectSheet } from "../auth/ConnectSheet.jsx";
import { AlgorandMark } from "../board/pieces.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { readGuestDemo, writeGuestDemo } from "../lib/storage.js";
import { PlayView } from "../play/PlayView.jsx";
import { usePlayFlow } from "../play/usePlayFlow.js";

export function Landing(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly onSignedIn: (player: PlayerView, linkedGuestClaims?: number) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [guestDemo, setGuestDemo] = useState(readGuestDemo);
  const flow = usePlayFlow({
    client: props.client,
    meta: props.meta,
    address: null,
    enabled: true,
    guest: true,
  });

  useEffect(() => {
    if (flow.state.phase === "RECEIPT" && flow.state.guest === true) {
      writeGuestDemo("played");
      setGuestDemo("played");
    } else if (flow.state.phase === "EXPIRED" && flow.state.guest === true) {
      writeGuestDemo("expired");
      setGuestDemo("expired");
    }
  }, [flow.state.phase, flow.state.guest]);

  return (
    <AppShell>
      <div className="hero2">
        <div style={{ maxWidth: 520 }}>
          <h1 style={{ fontSize: 62 }}>
            ONLY ONE MOVE.<span className="blink">▊</span>
          </h1>
          <p className="dim" style={{ marginTop: 8 }}>
            strangers and machines share a chess game — you play exactly one of
            its moves. if your side goes on to win, your cent becomes two.
          </p>
          <div className="ctas" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="bigplay"
              onClick={() => setConnecting(true)}
            >
              <span className="bp-title">▸ I HAVE AN ALGORAND WALLET</span>
              <span className="bp-sub">
                connect &amp; sign — one free signature, nothing is broadcast
              </span>
            </button>
            <a className="bigplay" href="/start">
              <span className="bp-title">I DON'T HAVE ONE YET →</span>
              <span className="bp-sub">set up a wallet, USDC and gas</span>
            </a>
            {guestDemo === null ? (
              <button
                type="button"
                className="bigplay demo"
                onClick={() =>
                  flow.send({ type: "PLAY", demo: true, guest: true })
                }
              >
                <span className="bp-title">PLAY A DEMO GAME</span>
                <span className="bp-sub">
                  $0 · no wallet needed · you make one real move
                </span>
              </button>
            ) : (
              <p className="console" data-testid="guest-demo-nudge">
                &gt; you have a demo game waiting — log in to see how it ends
              </p>
            )}
          </div>
          <p className="faintt" style={{ marginTop: 14, fontSize: 12 }}>
            internal playtest — mock settlement, no real USDC.
          </p>
        </div>
        <div className="algohero">
          <AlgorandMark size={110} />
          <span className="vt" style={{ fontSize: 30, letterSpacing: ".24em" }}>
            ALGORAND
          </span>
        </div>
      </div>
      <div
        className="landfoot"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 22,
          padding: "10px 30px",
          marginTop: 26,
          borderTop: "1px solid var(--line)",
          fontSize: 11.5,
          color: "var(--ph-dark)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <AlgorandMark /> RUNS ON ALGORAND
        </span>
        <span>· built for the x402 global challenge</span>
      </div>
      {flow.state.phase !== "IDLE" ? (
        <PlayView
          flow={flow}
          meta={props.meta}
          onWalletIntent={() => setConnecting(true)}
        />
      ) : null}
      {connecting ? (
        <ConnectSheet
          client={props.client}
          meta={props.meta}
          onSignedIn={props.onSignedIn}
          onClose={() => setConnecting(false)}
        />
      ) : null}
    </AppShell>
  );
}
