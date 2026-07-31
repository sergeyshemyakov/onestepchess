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
  formatElapsedTime,
  formatGameDuration,
  formatGameLabel,
  formatMicroUsdc,
} from "../lib/format.js";
import { CachedDigest } from "../replay/CachedDigest.jsx";
import {
  finishedMovesLabel,
  isFinishedStakedItem,
  ownedPlies,
  replayPath,
} from "./items.js";
import {
  outcomeFor,
  outcomeGlyph,
  repetitionAdjudicationNotice,
} from "./outcome.js";

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
  const repetitionNotice = repetitionAdjudicationNotice(
    item.result,
    item.repetitionAdjudication,
  );

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
          {repetitionNotice === null ? null : (
            <p className="repetition-decision">{repetitionNotice}</p>
          )}
          <p className="sub">you played {item.yourSide}</p>
          <p className="sub">
            your {item.yourMoves.length === 1 ? "move" : "moves"}:{" "}
            {finishedMovesLabel(item)} · DEMO — nothing staked, not counted
          </p>
          <p className="sub">
            thinking time: {formatElapsedTime(item.thinkingTimeMs)}
          </p>
          <p className="sub">
            duration {formatGameDuration(item.startedAt, item.finishedAt)}
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

  const plies = ownedPlies(item);
  const fullReplayPath = replayPath(item.gameId, plies);
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
        <h3>{formatGameLabel(item.gameId)}</h3>
        <CachedDigest
          client={client}
          gameId={item.gameId}
          highlightPlies={plies}
        />
        <p className="mv">{outcomeGlyph(outcome)}</p>
        <dl className="qv-fields">
          <dt>you played</dt>
          <dd>{item.yourSide}</dd>
          <dt>your {item.yourMoves.length === 1 ? "move" : "moves"}</dt>
          <dd>{finishedMovesLabel(item)}</dd>
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
          <dd>{formatElapsedTime(item.thinkingTimeMs)}</dd>
          <dt>duration</dt>
          <dd>{formatGameDuration(item.startedAt, item.finishedAt)}</dd>
        </dl>
        <div className="modal-actions pair">
          <Link className="btn mini" to={fullReplayPath}>
            full replay ▸
          </Link>
          <button
            type="button"
            className="btn mini"
            onClick={() => {
              void copyText(`${window.location.origin}${fullReplayPath}`).then(
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
            yourPlies={plies}
            refCode={props.refCode}
            onClose={() => setSharing(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
