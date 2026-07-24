import type { ApiClient } from "../api/client.js";
import { DigestLoop } from "./DigestLoop.jsx";
import { toReplayerPlies } from "./plies.js";
import { useReplay } from "./useReplay.js";

/** Shared lazy replay loader for the finished hero and quick-view. It keeps
 * stale game data off-screen and makes transient REST failures retryable. */
export function CachedDigest(props: {
  readonly client: ApiClient;
  readonly gameId: string;
  readonly highlightPly: number;
}) {
  const { load, retry } = useReplay(props.client, props.gameId);

  if (load.kind === "loading") {
    return <p className="console">&gt; loading replay…</p>;
  }
  if (load.kind === "failed" || load.kind === "missing") {
    return (
      <p className="formerr" role="alert">
        {load.kind === "failed"
          ? load.hint
          : (load.hint ?? "replay unavailable")}{" "}
        <button type="button" className="btn mini" onClick={retry}>
          retry ▸
        </button>
      </p>
    );
  }
  return (
    <DigestLoop
      plies={toReplayerPlies(load.replay.plies)}
      highlightPly={props.highlightPly}
    />
  );
}
