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
import { copyText } from "../lib/clipboard.js";
import { explorerTxUrl } from "../lib/explorer.js";
import {
  formatLocalTime,
  formatMicroUsdc,
  formatThinkingTime,
} from "../lib/format.js";
import { CachedDigest } from "../replay/CachedDigest.jsx";
import { isFinishedStakedItem } from "./items.js";
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
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, props.onClose);

  const outcome = outcomeFor(item.result, item.yourSide);

  if (!isFinishedStakedItem(item)) {
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

  const replayPath = `/replay/${item.gameId}?ply=${item.yourPly}`;
  const chip = payoutChip(item.payoutStatus);

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
        <h3>{item.gameName}</h3>
        <CachedDigest
          client={client}
          gameId={item.gameId}
          highlightPly={item.yourPly}
        />
        <p className="mv">{outcomeGlyph(outcome)}</p>
        <dl className="qv-fields">
          <dt>your move</dt>
          <dd>
            {item.yourMove.san} · ply {item.yourPly}
          </dd>
          <dt>stake</dt>
          <dd>
            {formatMicroUsdc(item.stakeMicroUsdc)}
            {item.payTxid !== null ? (
              <>
                {" "}
                <a
                  href={explorerTxUrl(
                    props.meta.network.explorerBaseUrl,
                    item.payTxid,
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
            {formatMicroUsdc(item.payoutMicroUsdc)}
            {chip !== null ? <span className="chip"> {chip}</span> : null}
            {item.payoutTxid !== null ? (
              <>
                {" "}
                <a
                  href={explorerTxUrl(
                    props.meta.network.explorerBaseUrl,
                    item.payoutTxid,
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
          <dd>{formatThinkingTime(item.claimedAt, item.movedAt)}</dd>
          <dt>finished</dt>
          <dd>{formatLocalTime(item.finishedAt)}</dd>
        </dl>
        <div className="modal-actions pair">
          <Link className="btn mini" to={replayPath}>
            full replay ▸
          </Link>
          <button
            type="button"
            className="btn mini"
            onClick={() => {
              void copyText(`${window.location.origin}${replayPath}`).then(
                (success) => {
                  if (success) setCopied(true);
                },
              );
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
            gameId={item.gameId}
            yourPly={item.yourPly}
            refCode={props.refCode}
            onClose={() => setSharing(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
