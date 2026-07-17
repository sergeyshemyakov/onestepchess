import { useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { ConnectSheet } from "../auth/ConnectSheet.jsx";
import { AlgorandMark } from "../board/pieces.jsx";
import { AppShell } from "../components/AppShell.jsx";

/** Release-1 landing: the wallet door only. The full two-door onboarding,
 * guest demo, and replay strip are Release 2 (W7/F-W4a) — no dead controls
 * implying support (release plan §2.8). */
export function Landing(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly onSignedIn: (player: PlayerView) => void;
}) {
  const [connecting, setConnecting] = useState(false);

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
