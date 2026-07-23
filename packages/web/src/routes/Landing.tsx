import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { ConnectSheet } from "../auth/ConnectSheet.jsx";
import { AlgorandMark } from "../board/pieces.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { PromoStrip } from "../components/PromoStrip.jsx";
import { StatsStrip } from "../components/StatsStrip.jsx";
import { DEEP_BLUE_GAME6 } from "../lib/deepblue-game6.js";
import { readGuestDemo, writeGuestDemo } from "../lib/storage.js";
import { PlayView } from "../play/PlayView.jsx";
import { usePlayFlow } from "../play/usePlayFlow.js";
import { Replayer } from "../replay/Replayer.jsx";

function HowItWorks(props: { readonly meta: Meta }) {
  const [tab, setTab] = useState<"human" | "agent">("human");
  const docs = props.meta.docs;
  return (
    <section className="howitworks" id="rules" data-testid="how-it-works">
      <div className="tabrow" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "human"}
          className={tab === "human" ? "tab active" : "tab"}
          onClick={() => setTab("human")}
        >
          FOR HUMANS
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "agent"}
          className={tab === "agent" ? "tab active" : "tab"}
          onClick={() => setTab("agent")}
        >
          FOR AGENTS
        </button>
      </div>
      {tab === "human" ? (
        // `/meta.rules` renders verbatim — the web never paraphrases (§8.4).
        <p className="rules console" data-testid="rules-verbatim">
          {props.meta.rules}
        </p>
      ) : (
        <div className="agenttab" data-testid="agent-tab">
          <p className="console">
            &gt; npx -y {docs.mcpPackage}
            {"\n"}&gt; # or speak x402 directly:
            {"\n"}&gt; curl -X POST /api/v1/claims # → claim + legal moves
            {"\n"}&gt; curl -X POST /api/v1/claims/:id/move # → 402
            PAYMENT-REQUIRED
            {"\n"}&gt; # sign the group, retry with PAYMENT-SIGNATURE → receipt
          </p>
          <p>
            <a href={docs.llms}>llms.txt</a> ·{" "}
            <a href={docs.openapi}>openapi</a> · {docs.mcpPackage} ·{" "}
            {docs.agentKitPackage} ·{" "}
            <a href={docs.repo} target="_blank" rel="noopener noreferrer">
              repo ↗
            </a>
          </p>
        </div>
      )}
    </section>
  );
}

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
    <AppShell
      belowBar={
        <>
          <PromoStrip />
          <div className="promostrip towerstrip" data-testid="tower-teaser">
            coming soon: integration with{" "}
            {/* announcement URL is CA-14 — text + link only, no brand assets (R13) */}
            <a
              href="https://worldchess.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              the tower, world chess's arena on algorand ↗
            </a>
          </div>
        </>
      }
    >
      <div className="landsplit" data-testid="landing-split">
        <div className="landfn">
          <h1 style={{ fontSize: 62 }}>
            ONLY ONE MOVE.<span className="blink">▊</span>
          </h1>
          <HowItWorks meta={props.meta} />
          <div className="ctas">
            <button
              type="button"
              className="bigplay"
              onClick={() => setConnecting(true)}
            >
              <span className="bp-title">▸ I HAVE AN ALGORAND WALLET</span>
              <span className="bp-sub">
                connect &amp; sign a zero transfer to log in
              </span>
            </button>
            <Link className="bigplay" to="/start">
              <span className="bp-title">I DON'T HAVE ONE YET →</span>
              <span className="bp-sub">set up a wallet, USDC and gas</span>
            </Link>
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
        <div className="landdeco">
          <section className="replaystrip" data-testid="deepblue-strip">
            <Replayer
              plies={DEEP_BLUE_GAME6.plies}
              autoPlay
              loop
              caption="deep blue – kasparov · game 6 · 1997 · 1-0"
            />
          </section>
        </div>
      </div>

      <StatsStrip meta={props.meta} />

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
        <a
          href={props.meta.docs.repo}
          target="_blank"
          rel="noopener noreferrer"
        >
          · GitHub ↗
        </a>
        <a href="#rules">· rules</a>
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
