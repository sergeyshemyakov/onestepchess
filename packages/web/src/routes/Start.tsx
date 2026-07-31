import { useState } from "react";
import { useNavigate } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { ConnectSheet } from "../auth/ConnectSheet.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { copyText } from "../lib/clipboard.js";

// F-W8 onboarding guide: fully static apart from the shared shell + the
// asset id from `/meta`. The copy names no network (CA-R10).

export function Start(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly onSignedIn: (player: PlayerView, linkedGuestClaims?: number) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const assetId = props.meta.network.usdcAssetId;

  return (
    <AppShell>
      <div className="guide" data-testid="start-guide">
        <h1 style={{ fontSize: 40 }}>GET SET UP</h1>
        <p className="dim">
          five steps from zero to your first move. a single cent is enough to
          play.
        </p>
        <ol className="checklist">
          <li>
            <b>
              install{" "}
              <a
                href="https://perawallet.app/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Pera ↗
              </a>
              ,{" "}
              <a
                href="https://defly.app/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Defly ↗
              </a>{" "}
              or{" "}
              <a
                href="https://lute.app/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Lute ↗
              </a>
              .
            </b>{" "}
            Pera is the easiest on a phone.
          </li>
          <li>
            <b>
              come back and sign in. you don't need any tokens, just sign a zero
              transfer to authenticate:
            </b>{" "}
            <button
              type="button"
              className="btn pri mini"
              onClick={() => setConnecting(true)}
            >
              ▸ I HAVE AN ALGORAND WALLET
            </button>
          </li>
        </ol>
        <p className="guide-full">
          <b>
            You can play demo games without USDC. For the full game experience:
          </b>
        </p>
        <ol className="checklist" start={3}>
          <li>
            <b>get ~0.25 ALGO (~2 ¢).</b> accounts need a ~0.201 ALGO floor to
            exist and hold USDC; the rest covers fees. buy in-app or withdraw
            from an exchange.
          </li>
          <li>
            <b>opt in to USDC in your wallet.</b> add the asset with this id:{" "}
            <button
              type="button"
              className="chip click"
              data-testid="asset-id-chip"
              onClick={() => {
                void copyText(assetId);
                setCopied(true);
              }}
            >
              {assetId} {copied ? "✓" : "⧉"}
            </button>{" "}
            .
          </li>
          <li>
            <b>get native USDC.</b> Pera's in-app swap or a CEX withdrawal both
            work.
            <p className="warn" role="note">
              ⚠ some bridges deliver <i>wrapped</i> USDC — a different asset.
              make sure the asset id matches the chip above.
            </p>
          </li>
        </ol>
      </div>
      {connecting ? (
        <ConnectSheet
          client={props.client}
          meta={props.meta}
          onSignedIn={(player, linkedGuestClaims) => {
            props.onSignedIn(player, linkedGuestClaims);
            navigate("/");
          }}
          onClose={() => setConnecting(false)}
        />
      ) : null}
    </AppShell>
  );
}
