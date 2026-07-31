import type { ApiClient } from "../api/client.js";
import { repetitionAdjudicationNotice } from "../games/outcome.js";
import { DigestLoop } from "./DigestLoop.jsx";
import { toReplayerPlies } from "./plies.js";
import { useReplay } from "./useReplay.js";

/** Shared lazy replay loader for the finished hero and quick-view. It keeps
 * stale game data off-screen and makes transient REST failures retryable. */
export function CachedDigest(props: {
  readonly client: ApiClient;
  readonly gameId: string;
  readonly highlightPlies: readonly number[];
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
  const finalNotice = repetitionAdjudicationNotice(
    load.replay.result,
    load.replay.repetitionAdjudication,
  );
  return (
    <DigestLoop
      plies={toReplayerPlies(load.replay.plies)}
      highlightPlies={props.highlightPlies}
      {...(finalNotice === null ? {} : { finalNotice })}
    />
  );
}
