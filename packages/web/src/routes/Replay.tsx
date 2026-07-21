import { Fragment, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { type ApiClient, ApiError } from "../api/client.js";
import { fetchReplayCached } from "../api/replayCache.js";
import type { ReplayView } from "../api/schemas.js";
import { AppShell } from "../components/AppShell.jsx";
import { parseUci } from "../lib/fen.js";
import { formatMicroUsdc } from "../lib/format.js";
import { Replayer } from "../replay/Replayer.jsx";
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
  const [load, setLoad] = useState<
    | {
        readonly gameId: string | undefined;
        readonly kind: "loading";
        readonly attempt: number;
      }
    | {
        readonly gameId: string;
        readonly kind: "ready";
        readonly replay: ReplayView;
      }
    | { readonly gameId: string | undefined; readonly kind: "missing" }
    | {
        readonly gameId: string | undefined;
        readonly kind: "failed";
        readonly hint: string;
      }
  >({ gameId, kind: "loading", attempt: 0 });
  const [retry, setRetry] = useState(0);
  const [ply, setPly] = useState(0);
  const [winratePly, setWinratePly] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const { client } = props;

  // biome-ignore lint/correctness/useExhaustiveDependencies(hintParam): the ?ply= hint applies once at load — scrubbing owns the position afterwards
  useEffect(() => {
    setLoad({ gameId, kind: "loading", attempt: retry });
    if (gameId === undefined) {
      setLoad({ gameId, kind: "missing" });
      return;
    }
    let cancelled = false;
    fetchReplayCached(client, gameId)
      .then((fetched) => {
        if (cancelled) return;
        setLoad({ gameId, kind: "ready", replay: fetched });
        const hint =
          Number.isInteger(hintParam) &&
          hintParam >= 1 &&
          hintParam <= fetched.plies.length
            ? hintParam
            : 0;
        setPly(hint);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setLoad({ gameId, kind: "missing" });
          return;
        }
        setLoad({
          gameId,
          kind: "failed",
          hint:
            error instanceof ApiError
              ? error.envelope.hint
              : "replay unavailable — try again",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, gameId, retry]);

  if (load.gameId === gameId && load.kind === "missing") {
    return <NotFound standalone />;
  }
  if (load.gameId === gameId && load.kind === "failed") {
    return (
      <AppShell showSystemBanner={false}>
        <div className="empty" role="alert">
          <span className="vt">[ SIGNAL LOST ]</span>
          {load.hint}
          <button
            type="button"
            className="btn mini"
            onClick={() => setRetry((current) => current + 1)}
          >
            retry ▸
          </button>
        </div>
      </AppShell>
    );
  }
  if (load.gameId !== gameId || load.kind !== "ready") {
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
        <header className="replayhead">
          <h1>{replay.name}</h1>
          <p className="dim">
            {replay.result === "white"
              ? "1-0"
              : replay.result === "black"
                ? "0-1"
                : replay.result === "draw"
                  ? "½-½"
                  : "aborted"}{" "}
            · {replay.termination}
          </p>
        </header>
        <div className="replaymain">
          <Replayer
            plies={replay.plies.map((item) => ({
              fenAfter: item.fenAfter,
              from: parseUci(item.move.uci).from,
              to: parseUci(item.move.uci).to,
            }))}
            controls
            ply={ply}
            onScrub={setPly}
            {...(highlightPly === undefined ? {} : { highlightPly })}
          />
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
                  {/* Winrate popover works by tap on touch (F-W6). */}
                  <button
                    type="button"
                    className="author"
                    onClick={() =>
                      setWinratePly(winratePly === item.ply ? null : item.ply)
                    }
                  >
                    {item.author.nickname ?? "anonymous"}{" "}
                    <span className="chip">{item.author.kind}</span>
                  </button>
                  {item.demo ? (
                    <span className="chip">$0 · DEMO</span>
                  ) : (
                    <span>{formatMicroUsdc(item.stakeMicroUsdc)}</span>
                  )}
                  {winratePly === item.ply ? (
                    <span className="winrate-pop" role="note">
                      {item.author.winratePct === null
                        ? "no decided games yet"
                        : `${Math.round(item.author.winratePct)}% winrate`}
                    </span>
                  ) : null}
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
              navigator.clipboard
                ?.writeText(`${window.location.origin}/replay/${replay.gameId}`)
                .then(() => setCopied(true))
                .catch(() => undefined);
            }}
          >
            {copied ? "copied ✓" : "copy link"}
          </button>
        </div>
      </div>
    </AppShell>
  );
}
