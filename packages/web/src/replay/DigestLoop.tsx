import { Replayer, type ReplayerPly } from "./Replayer.jsx";

/** §8.3 — the card-sized replay variant: auto-only, loops, gated on
 * IntersectionObserver + `document.hidden` (inside Replayer). At most two
 * animate concurrently by construction: the finished hero and one open
 * quick-view — archive grid cards are static by design. */
export function DigestLoop(props: {
  readonly plies: readonly ReplayerPly[];
  readonly highlightPly?: number;
  readonly caption?: string;
}) {
  return (
    <div className="digestloop">
      <Replayer
        plies={props.plies}
        autoPlay
        loop
        {...(props.highlightPly === undefined
          ? {}
          : { highlightPly: props.highlightPly })}
        {...(props.caption === undefined ? {} : { caption: props.caption })}
      />
    </div>
  );
}
