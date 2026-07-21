import { useEffect, useRef, useState } from "react";
import {
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
const LOOP_MS = 1_800;

/** SAN letter → piece; anything unrecognised is a pawn. */
function pieceFromSan(san: string, side: Side): Piece {
  const letter = san[0] ?? "";
  const type: PieceType = "NBRQK".includes(letter)
    ? (letter.toLowerCase() as PieceType)
    : "p";
  return { type, side };
}

/** F-W3/F-W4 shared board loop: one move gliding from → to forever, with a
 * capture burn when the SAN says so. With a `fen` it renders the real
 * position (CONFIRM morph); without one it renders a redacted empty board —
 * the ongoing hero derives everything from the item's own fields (I7), so
 * it replays identically after a reload. `prefers-reduced-motion` renders
 * the final frame statically. */
export function BoardLoop(props: {
  readonly from: string;
  readonly to: string;
  readonly san: string;
  readonly side: Side;
  readonly fen?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useLoopGate(hostRef);
  const [atTarget, setAtTarget] = useState(false);
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const capture = props.san.includes("x");

  useEffect(() => {
    if (!live || reduced) return;
    setAtTarget(false);
    let flip: ReturnType<typeof setTimeout> | undefined;
    const loop = setInterval(() => {
      setAtTarget(false);
      flip = setTimeout(() => setAtTarget(true), 150);
    }, LOOP_MS);
    flip = setTimeout(() => setAtTarget(true), 150);
    return () => {
      clearInterval(loop);
      if (flip !== undefined) clearTimeout(flip);
    };
  }, [live, reduced]);

  const piece =
    props.fen === undefined
      ? pieceFromSan(props.san, props.side)
      : (parseFenBoard(props.fen)[squareIndex(props.from)] ??
        pieceFromSan(props.san, props.side));
  const position = (square: string) => {
    const index = squareIndex(square);
    return { x: (index % 8) * 100, y: Math.floor(index / 8) * 100 };
  };
  const at = position(reduced ? props.to : atTarget ? props.to : props.from);

  return (
    <div className="boardloop" ref={hostRef} data-testid="board-loop">
      <Board
        fen={props.fen ?? EMPTY_FEN}
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
          className="boardloop-piece"
          style={{ transform: `translate(${at.x}%, ${at.y}%)` }}
        >
          <PieceGlyph type={piece.type} side={piece.side} />
        </span>
      </div>
    </div>
  );
}
