import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { ConnectSheet } from "../auth/ConnectSheet.jsx";
import { AlgorandMark } from "../board/pieces.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { GamePane } from "../components/GamePane.jsx";
import { PromoStrip } from "../components/PromoStrip.jsx";
import { StatsStrip } from "../components/StatsStrip.jsx";
import { TowerTeaser } from "../components/TowerTeaser.jsx";
import { DEEP_BLUE_GAME6 } from "../lib/deepblue-game6.js";
import { readGuestDemo, writeGuestDemo } from "../lib/storage.js";
import { PlayView } from "../play/PlayView.jsx";
import { usePlayFlow } from "../play/usePlayFlow.js";
import { Replayer } from "../replay/Replayer.jsx";

function HowItWorks(props: {
  readonly meta: Meta;
  readonly tab: "human" | "agent";
  readonly onTab: (tab: "human" | "agent") => void;
}) {
  const docs = props.meta.docs;
  const apiBase = new URL("/api/v1", docs.llms).toString().replace(/\/$/, "");
  const npmPackage = (name: string) =>
    `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
  return (
    <section className="howitworks" id="rules" data-testid="how-it-works">
      <div className="tabrow" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={props.tab === "human"}
          className={props.tab === "human" ? "tab active" : "tab"}
          onClick={() => props.onTab("human")}
        >
          FOR HUMANS
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.tab === "agent"}
          className={props.tab === "agent" ? "tab active" : "tab"}
          onClick={() => props.onTab("agent")}
        >
          FOR AGENTS
        </button>
      </div>
      {props.tab === "human" ? (
        // `/meta.rules` renders verbatim — the web never paraphrases (§8.4).
        <p className="rules console" data-testid="rules-verbatim">
          {props.meta.rules}
        </p>
      ) : (
        <div className="agenttab" data-testid="agent-tab">
          <p className="console">
            &gt; git clone {docs.botRepo}.git # run a bot — you bring the chess
            {"\n"}&gt; npx -y {docs.mcpPackage} # or let your LLM agent play
            {"\n"}&gt; # or speak x402 directly:
            {"\n"}&gt; curl -X POST {apiBase}/claims # → claim + legal moves
            {"\n"}&gt; curl -X POST {apiBase}/claims/:id/move # → 402
            PAYMENT-REQUIRED
            {"\n"}&gt; # sign the group, retry with PAYMENT-SIGNATURE → receipt
          </p>
          <p>
            <a href={docs.botRepo} target="_blank" rel="noopener noreferrer">
              onestepchess-bot ↗
            </a>{" "}
            · <a href={docs.llms}>llms.txt</a> ·{" "}
            <a href={docs.openapi}>openapi</a> ·{" "}
            <a href={npmPackage(docs.mcpPackage)}>{docs.mcpPackage}</a> ·{" "}
            <a href={npmPackage(docs.agentKitPackage)}>
              {docs.agentKitPackage}
            </a>{" "}
            ·{" "}
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
  const [audience, setAudience] = useState<"human" | "agent">("human");
  const [guestDemo, setGuestDemo] = useState(readGuestDemo);
  const [gamePaneDismissed, setGamePaneDismissed] = useState(false);
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

  const gamePanePhase =
    flow.state.phase === "GUEST_GATE" ||
    flow.state.phase === "CLAIMING" ||
    flow.state.phase === "FOCUS";
  const openDemoGame = () => {
    setGamePaneDismissed(false);
    if (!gamePanePhase) {
      flow.send({ type: "PLAY", demo: true, guest: true });
    }
  };
  const playView = (
    <PlayView
      flow={flow}
      meta={props.meta}
      onWalletIntent={() => setConnecting(true)}
    />
  );

  return (
    <AppShell
      hideNav
      belowBar={
        <>
          <PromoStrip />
          <TowerTeaser />
        </>
      }
    >
      <div className="landsplit" data-testid="landing-split">
        <div className="landfn">
          <h1 className="landtitle">
            ONLY ONE MOVE.<span className="blink">▊</span>
          </h1>
          <HowItWorks meta={props.meta} tab={audience} onTab={setAudience} />
          {audience === "human" ? (
            <div className="ctas">
              <button
                type="button"
                className="bigplay primary pulse-soft"
                onClick={() => setConnecting(true)}
              >
                <span className="bp-title">▸ I HAVE AN ALGORAND WALLET</span>
                <span className="bp-sub">
                  connect &amp; sign a zero transfer to log in
                </span>
              </button>
              <Link className="bigplay" to="/start">
                <span className="bp-title">
                  I DON'T HAVE AN ALGORAND WALLET
                </span>
                <span className="bp-sub">set up a wallet, USDC and gas</span>
              </Link>
              {guestDemo === null ? (
                <button
                  type="button"
                  className="bigplay demo"
                  onClick={openDemoGame}
                >
                  <span className="bp-title">PLAY A DEMO GAME</span>
                  <span className="bp-sub">
                    no wallet needed · you make one real move
                  </span>
                </button>
              ) : (
                <p className="console" data-testid="guest-demo-nudge">
                  &gt; you have a demo game waiting — log in to see how it ends
                </p>
              )}
            </div>
          ) : null}
        </div>
        <div className="landdeco">
          <section className="replaystrip" data-testid="deepblue-strip">
            <Replayer
              plies={DEEP_BLUE_GAME6.plies}
              autoPlay
              loop
              moveFx="glide"
              pliesPerSecond={1.5}
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
        <div style={{ flex: "1 1 0", display: "flex", alignItems: "center" }}>
          <a
            href="https://algorand.co/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Algorand website"
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <AlgorandMark /> RUNS ON ALGORAND
          </a>
        </div>
        <span>· built for the x402 global challenge</span>
        <div
          style={{
            flex: "1 1 0",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          <a
            href={props.meta.docs.repo}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub ↗
          </a>
          <Link to="/rules">· rules</Link>
        </div>
      </div>
      {gamePanePhase ? (
        gamePaneDismissed ? null : (
          <GamePane
            label="demo game"
            testId="landing-demo-popover"
            onClose={() => setGamePaneDismissed(true)}
          >
            {playView}
          </GamePane>
        )
      ) : flow.state.phase !== "IDLE" ? (
        playView
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
