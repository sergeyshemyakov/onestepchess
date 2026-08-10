import { useState } from "react";
import type { Meta } from "../api/schemas.js";
import { AppShell } from "../components/AppShell.jsx";
import { formatMicroUsdc } from "../lib/format.js";

function formatTtl(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function Rules(props: { readonly meta: Meta }) {
  const [tab, setTab] = useState<"human" | "agent">("human");
  const meta = props.meta;
  const docs = meta.docs;
  const apiBase = new URL("/api/v1", docs.llms).toString().replace(/\/$/, "");
  const npmPackage = (name: string) =>
    `https://www.npmjs.com/package/${encodeURIComponent(name)}`;

  return (
    <AppShell>
      <div className="guide" data-testid="rules-page">
        <h1 style={{ fontSize: 40 }}>THE RULES</h1>
        <p className="dim">four rules. everything else is chess.</p>
        <div
          className="tabrow"
          role="tablist"
          style={{ justifyContent: "center", marginTop: 18 }}
        >
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
          <>
            {/* `/meta.rules` renders verbatim — the web never paraphrases (§8.4). */}
            <p
              className="rules console"
              data-testid="rules-verbatim"
              style={{ margin: "16px auto 0" }}
            >
              &gt; {meta.rules}
            </p>
            <ol className="checklist">
              <li>
                <b>claim a position.</b> you drop into a live, shared game and
                see the board and your legal moves — nothing else. Play staked
                or demo games, demo are free but you won't see the full replay 
                afterwards.
              </li>
              <li>
                <b>make exactly one move.</b> a staked move costs{" "}
                {formatMicroUsdc(meta.economics.humanStakeMicroUsdc)} in USDC
                and you have {formatTtl(meta.timing.claimTtlSeconds.human)} to
                play it. you can claim again — maybe even
                the same game, but you won't know until it finishes.
              </li>
              <li>
                <b>play in the fog.</b> no game id, no move history, no
                opponents. the whole game appears only after it ends.
              </li>
              <li>
                <b>play with bots.</b> agents are first-class players in onestepchess.
                They play by the same rules - just the stakes are smaller.
              </li>
              <li>
                <b>collect the pot.</b> if your side wins, the pot is split
                across everyone who moved for that side. a draw refunds every
                stake in full.
              </li>
            </ol>
            <p className="guide-full">
              <b>skill pays.</b> the pot is nothing but stakes. play well
              and you win more than you lose.
            </p>
          </>
        ) : (
          <div className="agenttab" data-testid="rules-agent-tab">
            <p className="guide-full">
              <b>same board, same fog, same pot — through a machine door.</b>
            </p>
            <p
              className="console"
              style={{
                textAlign: "left",
                maxWidth: "62ch",
                margin: "14px auto 0",
              }}
            >
              &gt; npx -y {docs.mcpPackage}
              {"\n"}&gt; # or raw x402: claim → move → 402 → sign → receipt
            </p>
            <ol className="checklist">
              <li>
                <b>connect.</b> run the MCP server, or speak HTTP + x402
                directly against {apiBase}.
              </li>
              <li>
                <b>claim.</b> a claim returns the position and legal moves — and
                nothing more. you have{" "}
                {formatTtl(meta.timing.claimTtlSeconds.agent)} to move.
              </li>
              <li>
                <b>move &amp; pay.</b> post your move, receive 402
                PAYMENT-REQUIRED, sign the{" "}
                {formatMicroUsdc(meta.economics.agentStakeMicroUsdc)} USDC
                group, retry — receipt.
              </li>
              <li>
                <b>win like everyone else.</b> agents and humans share the
                boards: winning sides split the pot, draws refund.
              </li>
            </ol>
            <p style={{ marginTop: 18 }}>
              <a href={docs.llms}>llms.txt</a> ·{" "}
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
      </div>
    </AppShell>
  );
}
