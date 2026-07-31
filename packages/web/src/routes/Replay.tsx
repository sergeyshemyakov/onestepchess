import { Fragment, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { ReplayPly, ReplayView } from "../api/schemas.js";
import { AppShell } from "../components/AppShell.jsx";
import { replayPath } from "../games/items.js";
import { repetitionAdjudicationNotice } from "../games/outcome.js";
import { copyText } from "../lib/clipboard.js";
import { formatGameLabel, formatMicroUsdc } from "../lib/format.js";
import { toReplayerPlies } from "../replay/plies.js";
import { Replayer } from "../replay/Replayer.jsx";
import { useReplay } from "../replay/useReplay.js";
import { NotFound } from "./NotFound.jsx";

// F-W6 public replay: one GET renders everything; the page never calls
// authenticated endpoints. Unknown or non-terminal ids 404 → NotFound with
// no retry loop. `?plies=` carries shareable own-move hints from finished cards.

export function parseHighlightedPlies(
  value: string | null,
  maximum: number,
): number[] {
  if (value === null || value === "") return [];
  return [
    ...new Set(
      value
        .split(",")
        .map(Number)
        .filter((ply) => Number.isInteger(ply) && ply >= 1 && ply <= maximum),
    ),
  ].sort((a, b) => a - b);
}

function downloadPgn(replay: ReplayView): void {
  try {
    const blob = new Blob([replay.pgn], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${replay.gameId.replace(/^gm_/, "")}.pgn`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    // Blob URLs unavailable — the copyable PGN is still in the payload
  }
}

export function Replay(props: { readonly client: ApiClient }) {
  const { gameId } = useParams();
  const [searchParams] = useSearchParams();
  const { load, retry } = useReplay(props.client, gameId);
  const rawPlies = searchParams.get("plies");
  const highlightPlies = useMemo(
    () =>
      parseHighlightedPlies(
        rawPlies,
        load.kind === "ready"
          ? load.replay.plies.length
          : Number.MAX_SAFE_INTEGER,
      ),
    [load, rawPlies],
  );
  const [ply, setPly] = useState(0);
  const [author, setAuthor] = useState<ReplayPly["author"] | null>(null);
  const [copied, setCopied] = useState(false);
  // The first query hint applies when a replay loads; scrubbing owns it afterward.
  const initialHighlightPly = highlightPlies[0] ?? 0;
  useEffect(() => {
    if (load.kind !== "ready") return;
    setPly(initialHighlightPly);
  }, [load, initialHighlightPly]);

  if (load.kind === "missing") {
    return <NotFound standalone />;
  }
  if (load.gameId === gameId && load.kind === "failed") {
    return (
      <AppShell showSystemBanner={false}>
        <div className="empty" role="alert">
          <span className="vt">[ SIGNAL LOST ]</span>
          {load.hint}
          <button type="button" className="btn mini" onClick={retry}>
            retry ▸
          </button>
        </div>
      </AppShell>
    );
  }
  if (load.kind !== "ready") {
    return (
      <AppShell showSystemBanner={false}>
        <p className="console" style={{ padding: "40px 22px" }}>
          &gt; loading replay<span className="blink">▊</span>
        </p>
      </AppShell>
    );
  }
  const replay = load.replay;
  const finalNotice = repetitionAdjudicationNotice(
    replay.result,
    replay.repetitionAdjudication,
  );

  return (
    <AppShell showSystemBanner={false}>
      <div className="replaypage" data-testid="replay-page">
        <div className="replaymain">
          <div className="replayboardcol">
            <header className="replayhead">
              <h1>{formatGameLabel(replay.gameId)}</h1>
            </header>
            <Replayer
              plies={toReplayerPlies(replay.plies)}
              autoPlay
              controls
              speedControl
              loop
              loopToggle
              moveFx="glide"
              ply={ply}
              onScrub={setPly}
              highlightPlies={highlightPlies}
              {...(finalNotice === null ? {} : { finalNotice })}
            />
          </div>
          <div className="movelist" data-testid="move-list">
            {replay.plies.map((item) => (
              <Fragment key={item.ply}>
                {replay.endspielPly !== null &&
                item.ply === replay.endspielPly ? (
                  <p
                    className="endspiel-divider"
                    data-testid="endspiel-divider"
                  >
                    — endspiel · agents only —
                  </p>
                ) : null}
                <div
                  className={[
                    "plyrow",
                    item.ply === ply ? "cur" : "",
                    highlightPlies.includes(item.ply) ? "own" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    type="button"
                    className="plyjump"
                    onClick={() => setPly(item.ply)}
                  >
                    <span className="dim">{item.ply}</span>{" "}
                    <span className="mv">{item.move.san}</span>
                  </button>
                  {/* Player popup works by tap on touch (F-W6). */}
                  <button
                    type="button"
                    className="author"
                    onClick={() => setAuthor(item.author)}
                  >
                    {item.author.nickname ?? "anonymous"}{" "}
                    <span className="chip">{item.author.kind}</span>
                  </button>
                  {item.demo ? (
                    <span className="chip">$0 · DEMO</span>
                  ) : (
                    <span>{formatMicroUsdc(item.stakeMicroUsdc)}</span>
                  )}
                </div>
              </Fragment>
            ))}
          </div>
        </div>
        <div className="replayfoot">
          <button
            type="button"
            className="btn mini"
            onClick={() => downloadPgn(replay)}
          >
            download PGN ⇩
          </button>
          <button
            type="button"
            className="btn mini"
            onClick={() => {
              void copyText(
                `${window.location.origin}${
                  highlightPlies.length === 0
                    ? `/replay/${replay.gameId}`
                    : replayPath(replay.gameId, highlightPlies)
                }`,
              ).then((success) => {
                if (success) setCopied(true);
              });
            }}
          >
            {copied ? "copied ✓" : "copy link"}
          </button>
        </div>
        {author !== null ? (
          <div className="modalback">
            <div
              className="modal"
              role="dialog"
              aria-modal="true"
              data-testid="player-popup"
            >
              <h3>PLAYER</h3>
              <p className="mv">{author.nickname ?? "anonymous"}</p>
              <dl className="qv-fields">
                <dt>type</dt>
                <dd>{author.kind}</dd>
                <dt>total moves</dt>
                <dd>{author.movesTotal}</dd>
                <dt>winrate</dt>
                <dd>
                  {author.winratePct === null
                    ? "no decided games yet"
                    : `${Math.round(author.winratePct)}%`}
                </dd>
              </dl>
              <div className="modal-actions single">
                <button
                  type="button"
                  className="btn mini"
                  onClick={() => setAuthor(null)}
                >
                  close
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
