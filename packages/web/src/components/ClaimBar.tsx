import { useEffect, useState } from "react";
import { formatCountdown, secondsUntil } from "../lib/format.js";

/** `▮ board reserved · T−mm:ss · return ▸` — shown whenever a claim is open
 * and the play surface isn't visible, so a claim never silently expires
 * while browsing (F-W7 subset). Countdown derives from the server deadline
 * vs the local clock at render (§4.5). */
export function ClaimBar(props: {
  readonly deadline: string;
  readonly onReturn: () => void;
  readonly now?: () => number;
}) {
  const now = props.now ?? Date.now;
  const [left, setLeft] = useState(() => secondsUntil(props.deadline, now()));

  useEffect(() => {
    const tick = setInterval(() => {
      const next = secondsUntil(props.deadline, now());
      setLeft(next);
      if (next <= 0) clearInterval(tick);
    }, 1_000);
    return () => clearInterval(tick);
  }, [props.deadline, now]);

  return (
    <div className="claimbar">
      <span className="blink">▮</span>
      board reserved — you have a move to make ·{" "}
      <b>T−{formatCountdown(left)}</b>
      <button type="button" className="btn mini" onClick={props.onReturn}>
        return to board ▸
      </button>
    </div>
  );
}
