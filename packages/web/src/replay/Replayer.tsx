import { useCallback, useEffect, useRef, useState } from "react";
import { Board, type BoardFx } from "../board/Board.jsx";

export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Minimal ply shape every replay surface shares — server plies and the
 * bundled Deep Blue asset both satisfy it. Rendering is fenAfter-indexed:
 * scrubbing never recomputes moves (F-W6). */
export type ReplayerPly = {
  readonly fenAfter: string;
  readonly from?: string;
  readonly to?: string;
};

/** Animation loops gate on IntersectionObserver + document.hidden and idle
 * ≥ 1 s off-screen (§9). Environments without IntersectionObserver (tests)
 * count as visible. */
export function useLoopGate(ref: {
  readonly current: HTMLElement | null;
}): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [hidden, setHidden] = useState(
    typeof document !== "undefined" && document.hidden,
  );

  useEffect(() => {
    const host = ref.current;
    if (host === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return onScreen && !hidden;
}

const END_HOLD_MS = 2_000;
const HIGHLIGHT_HOLD_MS = 1_000;

export function Replayer(props: {
  readonly plies: readonly ReplayerPly[];
  readonly startFen?: string;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly controls?: boolean;
  readonly pliesPerSecond?: number;
  readonly moveFx?: BoardFx["kind"];
  /** 1-based ply that plays in slow motion with a flash (own-move accent). */
  readonly highlightPly?: number;
  readonly onPly?: (ply: number) => void;
  readonly caption?: string;
  /** External scrub position (route scrubber/keyboard drive this). */
  readonly ply?: number;
  readonly onScrub?: (ply: number) => void;
}) {
  const startFen = props.startFen ?? START_FEN;
  const [internalPly, setInternalPly] = useState(
    props.autoPlay === true ? 0 : (props.ply ?? 0),
  );
  const [playing, setPlaying] = useState(props.autoPlay === true);
  const holdRef = useRef(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useLoopGate(hostRef);
  const controlled = props.ply !== undefined;
  const ply = controlled ? (props.ply as number) : internalPly;
  const total = props.plies.length;
  const { onPly, onScrub } = props;

  const setPly = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(total, next));
      if (!controlled) setInternalPly(clamped);
      onScrub?.(clamped);
      onPly?.(clamped);
    },
    [controlled, total, onScrub, onPly],
  );

  useEffect(() => {
    if (!playing || !live || total === 0) return;
    const intervalMs = 1_000 / (props.pliesPerSecond ?? 4);
    const holdTicks = (durationMs: number) =>
      Math.max(0, Math.ceil(durationMs / intervalMs) - 1);
    const interval = setInterval(() => {
      if (holdRef.current > 0) {
        holdRef.current -= 1;
        return;
      }
      if (controlled) {
        // Controlled auto mode: the owner advances via onScrub.
        const next = ply >= total ? (props.loop === true ? 0 : ply) : ply + 1;
        if (next === ply) setPlaying(false);
        else {
          if (next === props.highlightPly)
            holdRef.current = holdTicks(HIGHLIGHT_HOLD_MS);
          if (next === total) holdRef.current = holdTicks(END_HOLD_MS);
          onScrub?.(next);
          onPly?.(next);
        }
        return;
      }
      setInternalPly((current) => {
        if (current >= total) {
          if (props.loop === true) return 0;
          setPlaying(false);
          return current;
        }
        const next = current + 1;
        if (next === props.highlightPly)
          holdRef.current = holdTicks(HIGHLIGHT_HOLD_MS);
        if (next === total) holdRef.current = holdTicks(END_HOLD_MS);
        onPly?.(next);
        return next;
      });
    }, intervalMs);
    return () => clearInterval(interval);
  }, [
    playing,
    live,
    total,
    controlled,
    ply,
    props.loop,
    props.highlightPly,
    props.pliesPerSecond,
    onScrub,
    onPly,
  ]);

  // F-W6 keyboard bindings: ←/→ scrub, space toggles auto (controls only).
  useEffect(() => {
    if (props.controls !== true) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowLeft") {
        setPlaying(false);
        setPly(ply - 1);
      } else if (event.key === "ArrowRight") {
        setPlaying(false);
        setPly(ply + 1);
      } else if (event.key === " ") {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.controls, ply, setPly]);

  const current = ply === 0 ? null : (props.plies[ply - 1] ?? null);
  const fen = current === null ? startFen : current.fenAfter;
  const lastMove =
    current !== null && current.from !== undefined && current.to !== undefined
      ? { from: current.from, to: current.to }
      : null;
  const moveFx: BoardFx | null =
    props.moveFx !== undefined &&
    current !== null &&
    current.from !== undefined &&
    current.to !== undefined
      ? {
          kind: props.moveFx,
          from: current.from,
          to: current.to,
          seq: ply,
        }
      : null;
  const atHighlight =
    props.highlightPly !== undefined && ply === props.highlightPly;

  return (
    <div className="replayer" ref={hostRef} data-testid="replayer">
      <div
        className={atHighlight ? "replayer-board own-ply" : "replayer-board"}
      >
        <Board fen={fen} lastMove={lastMove} fx={moveFx} />
      </div>
      {props.caption !== undefined ? (
        <p className="replayer-caption">{props.caption}</p>
      ) : null}
      {props.controls === true ? (
        <div className="replayer-controls">
          <button
            type="button"
            className="btn mini"
            aria-label="previous ply"
            onClick={() => {
              setPlaying(false);
              setPly(ply - 1);
            }}
          >
            ◂
          </button>
          <button
            type="button"
            className="btn mini"
            aria-label={playing ? "pause" : "play"}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="btn mini"
            aria-label="next ply"
            onClick={() => {
              setPlaying(false);
              setPly(ply + 1);
            }}
          >
            ▸
          </button>
          <input
            type="range"
            className="replayer-scrub"
            aria-label="scrub plies"
            min={0}
            max={total}
            value={ply}
            onChange={(event) => {
              setPlaying(false);
              setPly(Number(event.target.value));
            }}
          />
          <span className="replayer-pos">
            {ply}/{total}
          </span>
        </div>
      ) : null}
    </div>
  );
}
