import { useRef, useState } from "react";
import { Link } from "react-router";
import type { ApiClient } from "../api/client.js";
import type {
  FinishedDemoItem,
  FinishedStakedItem,
  Meta,
} from "../api/schemas.js";
import { ShareSheet } from "../components/ShareSheet.jsx";
import { useDialogFocusTrap } from "../components/useDialogFocusTrap.js";
import { explorerTxUrl } from "../lib/explorer.js";
import {
  formatLocalTime,
  formatMicroUsdc,
  formatThinkingTime,
} from "../lib/format.js";
import { CachedDigest } from "../replay/CachedDigest.jsx";
import { outcomeFor, outcomeGlyph } from "./outcome.js";

export function payoutChip(
  status: FinishedStakedItem["payoutStatus"],
): string | null {
  switch (status) {
    case "queued":
      return "queued…";
    case "confirmed":
      return "confirmed ↗";
    case "failed":
      return "failed — operator notified";
    case "none":
      return null;
  }
}

/** F-W5 quick-view sheet: digest replay + full fields for staked entries;
 * the demo variant renders result + move only — no id anywhere. The replay
 * loads on open and is cached (§5.1). */
export function QuickView(props: {
  readonly client: ApiClient;
  readonly item: FinishedStakedItem | FinishedDemoItem;
  readonly meta: Meta;
  readonly refCode: string | null;
  readonly onClose: () => void;
}) {
  const { item, client } = props;
  // Discriminate on the pinned `demo` flag, never on field presence — a
  // regression payload carrying identity fields on a demo item must still
  // render the demo variant (I7 defense in depth).
  const staked = !item.demo;
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, props.onClose);

  const outcome = outcomeFor(item.result, item.yourSide);

  if (!staked) {
    return (
      <div className="modalback">
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="modal quickview"
          role="dialog"
          aria-modal="true"
          data-testid="quick-view-demo"
        >
          <h3>— demo —</h3>
          <p className="mv">{outcomeGlyph(outcome)}</p>
          <p className="sub">
            your move: {item.yourMove.san} · DEMO — nothing staked, not counted
          </p>
          <p className="dim">replay locked for demo moves</p>
          <div className="modal-actions single">
            <button type="button" className="btn mini" onClick={props.onClose}>
              close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const stakedItem = item as FinishedStakedItem;
  const replayPath = `/replay/${stakedItem.gameId}?ply=${stakedItem.yourPly}`;
  const chip = payoutChip(stakedItem.payoutStatus);

  return (
    <div className="modalback">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal quickview"
        role="dialog"
        aria-modal="true"
        data-testid="quick-view"
      >
        <h3>{stakedItem.gameName}</h3>
        <CachedDigest
          client={client}
          gameId={stakedItem.gameId}
          highlightPly={stakedItem.yourPly}
        />
        <p className="mv">{outcomeGlyph(outcome)}</p>
        <dl className="qv-fields">
          <dt>your move</dt>
          <dd>
            {stakedItem.yourMove.san} · ply {stakedItem.yourPly}
          </dd>
          <dt>stake</dt>
          <dd>
            {formatMicroUsdc(stakedItem.stakeMicroUsdc)}
            {stakedItem.payTxid !== null ? (
              <>
                {" "}
                <a
                  href={explorerTxUrl(
                    props.meta.network.explorerBaseUrl,
                    stakedItem.payTxid,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  tx ↗
                </a>
              </>
            ) : null}
          </dd>
          <dt>payout</dt>
          <dd>
            {formatMicroUsdc(stakedItem.payoutMicroUsdc)}
            {chip !== null ? <span className="chip"> {chip}</span> : null}
            {stakedItem.payoutTxid !== null ? (
              <>
                {" "}
                <a
                  href={explorerTxUrl(
                    props.meta.network.explorerBaseUrl,
                    stakedItem.payoutTxid,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  tx ↗
                </a>
              </>
            ) : null}
          </dd>
          <dt>thinking time</dt>
          <dd>
            {formatThinkingTime(stakedItem.claimedAt, stakedItem.movedAt)}
          </dd>
          <dt>finished</dt>
          <dd>{formatLocalTime(stakedItem.finishedAt)}</dd>
        </dl>
        <div className="modal-actions pair">
          <Link className="btn mini" to={replayPath}>
            full replay ▸
          </Link>
          <button
            type="button"
            className="btn mini"
            onClick={() => {
              navigator.clipboard
                ?.writeText(`${window.location.origin}${replayPath}`)
                .then(() => setCopied(true))
                .catch(() => undefined);
            }}
          >
            {copied ? "copied ✓" : "copy link"}
          </button>
          {outcome === "won" ? (
            <button
              type="button"
              className="btn pri mini"
              onClick={() => setSharing(true)}
            >
              share ▸
            </button>
          ) : null}
        </div>
        <div className="modal-actions single">
          <button type="button" className="btn mini" onClick={props.onClose}>
            close
          </button>
        </div>
        {sharing ? (
          <ShareSheet
            gameId={stakedItem.gameId}
            yourPly={stakedItem.yourPly}
            refCode={props.refCode}
            onClose={() => setSharing(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
