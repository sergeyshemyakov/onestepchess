import { useEffect, useRef, useState } from "react";
import {
  fenWithoutSquare,
  type Piece,
  type PieceType,
  parseFenBoard,
  type Side,
  squareIndex,
} from "../lib/fen.js";
import { useLoopGate } from "../replay/Replayer.jsx";
import { Board } from "./Board.jsx";
import { PieceGlyph } from "./pieces.jsx";

const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";
/** Glide (1.2s) + hold, then a suppressed-transition reset frame. */
const LOOP_MS = 2_600;
const RESET_MS = 150;

/** SAN letter → piece; anything unrecognised is a pawn. */
function pieceFromSan(san: string, side: Side): Piece {
  const letter = san[0] ?? "";
  const type: PieceType = "NBRQK".includes(letter)
    ? (letter.toLowerCase() as PieceType)
    : "p";
  return { type, side };
}

/** F-W3/F-W4 shared board loop: one move gliding from → to forever, with a
 * capture burn when the SAN says so. With a `fen` (the cached claim
 * position) it renders the real board minus the mover, so every other piece
 * stays put while the mover loops; without one it renders the redacted
 * empty board — ongoing items carry no position on purpose (I7).
 * The reset teleports (transition suppressed) so the glide always starts
 * cleanly from the source square. `prefers-reduced-motion` renders the
 * final frame statically. */
export function BoardLoop(props: {
  readonly from: string;
  readonly to: string;
  readonly san: string;
  readonly side: Side;
  readonly fen?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useLoopGate(hostRef);
  const [phase, setPhase] = useState<"rest" | "glide">("rest");
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const capture = props.san.includes("x");

  useEffect(() => {
    if (!live || reduced) return;
    let step: ReturnType<typeof setTimeout> | undefined;
    const cycle = () => {
      setPhase("rest");
      step = setTimeout(() => setPhase("glide"), RESET_MS);
    };
    cycle();
    const loop = setInterval(cycle, LOOP_MS);
    return () => {
      clearInterval(loop);
      if (step !== undefined) clearTimeout(step);
    };
  }, [live, reduced]);

  const piece =
    props.fen === undefined
      ? pieceFromSan(props.san, props.side)
      : (parseFenBoard(props.fen)[squareIndex(props.from)] ??
        pieceFromSan(props.san, props.side));
  const boardFen =
    props.fen === undefined ? EMPTY_FEN : fenWithoutSquare(props.fen, props.from);
  const position = (square: string) => {
    const index = squareIndex(square);
    return { x: (index % 8) * 100, y: Math.floor(index / 8) * 100 };
  };
  const atTarget = reduced || phase === "glide";
  const at = position(atTarget ? props.to : props.from);

  return (
    <div className="boardloop" ref={hostRef} data-testid="board-loop">
      <Board
        fen={boardFen}
        lastMove={{ from: props.from, to: props.to }}
      />
      <div className="boardloop-layer" aria-hidden="true">
        {capture && atTarget ? (
          <span
            className="boardloop-burn"
            style={{
              transform: `translate(${position(props.to).x}%, ${position(props.to).y}%)`,
            }}
          />
        ) : null}
        <span
          className={
            phase === "rest" && !reduced
              ? "boardloop-piece noanim"
              : "boardloop-piece"
          }
          style={{ transform: `translate(${at.x}%, ${at.y}%)` }}
        >
          <PieceGlyph type={piece.type} side={piece.side} />
        </span>
      </div>
    </div>
  );
}
