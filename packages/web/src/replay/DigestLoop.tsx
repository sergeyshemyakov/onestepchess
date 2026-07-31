import { Replayer, type ReplayerPly } from "./Replayer.jsx";

/** §8.3 — the card-sized replay variant: auto-only, loops, gated on
 * IntersectionObserver + `document.hidden` (inside Replayer). At most two
 * animate concurrently by construction: the finished hero and one open
 * quick-view — archive grid cards are static by design. */
export function DigestLoop(props: {
  readonly plies: readonly ReplayerPly[];
  readonly highlightPlies?: readonly number[];
  readonly caption?: string;
  readonly finalNotice?: string;
}) {
  return (
    <div className="digestloop">
      <Replayer
        plies={props.plies}
        autoPlay
        loop
        moveFx="glide"
        {...(props.highlightPlies === undefined
          ? {}
          : { highlightPlies: props.highlightPlies })}
        {...(props.caption === undefined ? {} : { caption: props.caption })}
        {...(props.finalNotice === undefined
          ? {}
          : { finalNotice: props.finalNotice })}
      />
    </div>
  );
}
