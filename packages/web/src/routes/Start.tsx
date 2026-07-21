import { useState } from "react";
import { useNavigate } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { Meta, PlayerView } from "../api/schemas.js";
import { ConnectSheet } from "../auth/ConnectSheet.jsx";
import { AppShell } from "../components/AppShell.jsx";

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
          play. really.
        </p>
        <ol className="checklist">
          <li>
            <b>install Pera.</b> any Algorand wallet works — Pera is the easiest
            on a phone.
          </li>
          <li>
            <b>get ~0.25 ALGO.</b> accounts need a ~0.201 ALGO floor to exist
            and hold USDC; the rest covers fees. buy in-app or withdraw from an
            exchange.
          </li>
          <li>
            <b>opt in to USDC.</b> add the asset with this id:{" "}
            <button
              type="button"
              className="chip click"
              data-testid="asset-id-chip"
              onClick={() => {
                navigator.clipboard?.writeText(assetId).catch(() => undefined);
                setCopied(true);
              }}
            >
              {assetId} {copied ? "✓" : "⧉"}
            </button>{" "}
            opting in raises your minimum balance by 0.1 ALGO.
          </li>
          <li>
            <b>get native USDC.</b> Pera's in-app swap or a Coinbase withdrawal
            both work.
            <p className="warn" role="note">
              ⚠ bridges deliver <i>wrapped</i> USDC — a different asset. make
              sure the asset id matches the chip above.
            </p>
          </li>
          <li>
            <b>come back and sign in.</b>{" "}
            <button
              type="button"
              className="btn pri mini"
              onClick={() => setConnecting(true)}
            >
              ▸ I HAVE AN ALGORAND WALLET
            </button>
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
