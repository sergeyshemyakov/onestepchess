import { useEffect, useMemo, useRef, useState } from "react";
import { formatCountdown, secondsUntil } from "../lib/format.js";

export const TIMER_URGENT_SECONDS = 30;

export type TimerPhase = "quiet" | "warn" | "crit" | "expired";

/** The D9 policy (§4.6): quiet draining bar → numeric at the reveal
 * threshold (`/meta.timing.timerRevealSeconds`) → inverse blink at 30s.
 * Countdown always derives from the server deadline vs the local clock at
 * render — never a client-counted duration. Expiry here is UI-cosmetic;
 * the authoritative transition is the server's 410/status poll (§5.5). */
export function timerPhase(
  left: number,
  revealSeconds: number,
  urgentSeconds: number = TIMER_URGENT_SECONDS,
): TimerPhase {
  if (left <= 0) return "expired";
  if (left <= urgentSeconds) return "crit";
  if (left <= revealSeconds) return "warn";
  return "quiet";
}

export function Timer(props: {
  readonly deadline: string;
  readonly revealSeconds: number;
  readonly totalSeconds?: number;
  readonly urgentSeconds?: number;
  readonly now?: () => number;
  readonly onExpire?: () => void;
}) {
  const now = props.now ?? Date.now;
  const [left, setLeft] = useState(() => secondsUntil(props.deadline, now()));
  const expiredFired = useRef(false);
  const reducedMotion = useMemo(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const total = Math.max(props.totalSeconds ?? Math.max(left, 1), 1);

  useEffect(() => {
    expiredFired.current = false;
    setLeft(secondsUntil(props.deadline, now()));
    const tick = setInterval(() => {
      const next = secondsUntil(props.deadline, now());
      setLeft(next);
      if (next <= 0) clearInterval(tick);
    }, 300);
    return () => clearInterval(tick);
  }, [props.deadline, now]);

  const phase = timerPhase(
    left,
    props.revealSeconds,
    props.urgentSeconds ?? TIMER_URGENT_SECONDS,
  );

  useEffect(() => {
    if (phase === "expired" && !expiredFired.current) {
      expiredFired.current = true;
      props.onExpire?.();
    }
  }, [phase, props.onExpire]);

  const className = [
    "timer",
    phase === "warn" ? "warn" : "",
    phase === "crit" || phase === "expired" ? "crit" : "",
    reducedMotion ? "rm" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (phase === "quiet") {
    const pct = Math.round((left / total) * 200) / 2;
    return (
      <span className={className} data-phase={phase}>
        ▮ board is yours
        <span className="bar">
          <i style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
      </span>
    );
  }
  return (
    <span className={className} data-phase={phase}>
      T-{formatCountdown(left)}
    </span>
  );
}
