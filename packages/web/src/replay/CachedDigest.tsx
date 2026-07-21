import { useEffect, useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import { fetchReplayCached } from "../api/replayCache.js";
import type { ReplayView } from "../api/schemas.js";
import { parseUci } from "../lib/fen.js";
import { DigestLoop } from "./DigestLoop.jsx";

type DigestLoad =
  | {
      readonly gameId: string;
      readonly kind: "loading";
      readonly attempt: number;
    }
  | {
      readonly gameId: string;
      readonly kind: "ready";
      readonly replay: ReplayView;
    }
  | { readonly gameId: string; readonly kind: "failed"; readonly hint: string };

/** Shared lazy replay loader for the finished hero and quick-view. It keeps
 * stale game data off-screen and makes transient REST failures retryable. */
export function CachedDigest(props: {
  readonly client: ApiClient;
  readonly gameId: string;
  readonly highlightPly: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<DigestLoad>({
    gameId: props.gameId,
    kind: "loading",
    attempt: 0,
  });
  const { client, gameId } = props;

  useEffect(() => {
    let cancelled = false;
    setLoad({ gameId, kind: "loading", attempt });
    fetchReplayCached(client, gameId)
      .then((replay) => {
        if (!cancelled) setLoad({ gameId, kind: "ready", replay });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
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
  }, [attempt, client, gameId]);

  if (load.gameId !== gameId || load.kind === "loading") {
    return <p className="console">&gt; loading replay…</p>;
  }
  if (load.kind === "failed") {
    return (
      <p className="formerr" role="alert">
        {load.hint}{" "}
        <button
          type="button"
          className="btn mini"
          onClick={() => setAttempt((current) => current + 1)}
        >
          retry ▸
        </button>
      </p>
    );
  }
  return (
    <DigestLoop
      plies={load.replay.plies.map((ply) => ({
        fenAfter: ply.fenAfter,
        from: parseUci(ply.move.uci).from,
        to: parseUci(ply.move.uci).to,
      }))}
      highlightPly={props.highlightPly}
    />
  );
}
