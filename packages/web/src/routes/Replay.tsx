import { Fragment, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { ReplayPly, ReplayView } from "../api/schemas.js";
import { AppShell } from "../components/AppShell.jsx";
import { copyText } from "../lib/clipboard.js";
import { formatMicroUsdc } from "../lib/format.js";
import { toReplayerPlies } from "../replay/plies.js";
import { Replayer } from "../replay/Replayer.jsx";
import { useReplay } from "../replay/useReplay.js";
import { NotFound } from "./NotFound.jsx";

// F-W6 public replay: one GET renders everything; the page never calls
// authenticated endpoints. Unknown or non-terminal ids 404 → NotFound with
// no retry loop. `?ply=` is a client-side own-move hint from finished cards.

function downloadPgn(replay: ReplayView): void {
  try {
    const blob = new Blob([replay.pgn], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${replay.name}.pgn`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    // Blob URLs unavailable — the copyable PGN is still in the payload
  }
}

export function Replay(props: { readonly client: ApiClient }) {
  const { gameId } = useParams();
  const [searchParams] = useSearchParams();
  const hintParam = Number(searchParams.get("ply") ?? "");
  const { load, retry } = useReplay(props.client, gameId);
  const [ply, setPly] = useState(0);
  const [author, setAuthor] = useState<ReplayPly["author"] | null>(null);
  const [copied, setCopied] = useState(false);
  // The query hint applies when a replay loads; scrubbing owns it afterward.
  // biome-ignore lint/correctness/useExhaustiveDependencies(hintParam): changing only ?ply= must not reset the current scrub position
  useEffect(() => {
    if (load.kind !== "ready") return;
    const hint =
      Number.isInteger(hintParam) &&
      hintParam >= 1 &&
      hintParam <= load.replay.plies.length
        ? hintParam
        : 0;
    setPly(hint);
  }, [load]);

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

  const highlightPly =
    Number.isInteger(hintParam) &&
    hintParam >= 1 &&
    hintParam <= replay.plies.length
      ? hintParam
      : undefined;

  return (
    <AppShell showSystemBanner={false}>
      <div className="replaypage" data-testid="replay-page">
        <div className="replaymain">
          <div className="replayboardcol">
            <header className="replayhead">
              {/* The URL id, not the word-list name — names collide with
               * nickname vocabulary and read like a player (playtest round 2). */}
              <h1>Game {replay.gameId.replace(/^gm_/, "")}</h1>
            </header>
            <Replayer
              plies={toReplayerPlies(replay.plies)}
              controls
              loop
              loopToggle
              moveFx="glide"
              ply={ply}
              onScrub={setPly}
              {...(highlightPly === undefined ? {} : { highlightPly })}
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
                    item.ply === highlightPly ? "own" : "",
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
                `${window.location.origin}/replay/${replay.gameId}`,
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
