import { useEffect, useRef, useState } from "react";
import {
  fenWithoutSquare,
  type Piece,
  type PieceType,
  parseFenBoard,
  type Side,
  squareIndex,
} from "../lib/fen.js";
import { useLoopGate } from "../replay/useLoopGate.js";
import { Board } from "./Board.jsx";
import { castlingRookMove } from "./castling.js";
import { PieceGlyph } from "./pieces.jsx";
import { useSquareSize } from "./useSquareSize.js";

const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";

type Phase = "rest" | "erase" | "type" | "hold";

/** One scanline cycle: the claim position at rest, the mover erases while
 * the beam sweeps, types in on the target, holds — then teleports back. */
const PHASES: ReadonlyArray<readonly [Phase, number]> = [
  ["rest", 900],
  ["erase", 200],
  ["type", 380],
  ["hold", 1_100],
];

/** SAN letter → piece; anything unrecognised is a pawn. */
function pieceFromSan(san: string, side: Side): Piece {
  const letter = san[0] ?? "";
  const type: PieceType = san.startsWith("O-O")
    ? "k"
    : "NBRQK".includes(letter)
      ? (letter.toLowerCase() as PieceType)
      : "p";
  return { type, side };
}

/** F-W3 active-game board loop: the user's move replayed forever with the
 * scanline type-in FX (UI suggestions "type" mode). With a `fen` the base
 * board renders the pre-move position minus the actors the overlay animates;
 * without one, as allowed by the shared CONFIRM surface, it renders only the
 * mover. `prefers-reduced-motion` renders the final frame statically. */
export function BoardLoop(props: {
  readonly from: string;
  readonly to: string;
  readonly san: string;
  readonly side: Side;
  readonly fen?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useLoopGate(hostRef);
  useSquareSize(hostRef);
  const [phase, setPhase] = useState<Phase>("rest");
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const capture = props.san.includes("x");

  useEffect(() => {
    if (!live || reduced) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let index = 0;
    const step = () => {
      const entry = PHASES[index];
      if (entry === undefined) return;
      setPhase(entry[0]);
      timer = setTimeout(step, entry[1]);
      index = (index + 1) % PHASES.length;
    };
    step();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [live, reduced]);

  const board = props.fen === undefined ? null : parseFenBoard(props.fen);
  const mover =
    board?.[squareIndex(props.from)] ?? pieceFromSan(props.san, props.side);
  const rookMove =
    mover.type === "k" ? castlingRookMove(props.from, props.to) : null;
  const rook =
    rookMove === null
      ? null
      : (board?.[squareIndex(rookMove.from)] ?? {
          type: "r" as const,
          side: props.side,
        });
  // En passant: a pawn capturing onto an empty square — the victim sits on
  // the target file at the origin rank, not on the target square.
  const enPassant =
    capture &&
    board !== null &&
    mover.type === "p" &&
    board[squareIndex(props.to)] === null;
  const victimSquare = enPassant ? `${props.to[0]}${props.from[1]}` : props.to;
  const victim = capture ? (board?.[squareIndex(victimSquare)] ?? null) : null;
  const baseFen =
    props.fen === undefined
      ? EMPTY_FEN
      : fenWithoutSquare(
          rookMove === null
            ? capture
              ? fenWithoutSquare(props.fen, victimSquare)
              : props.fen
            : fenWithoutSquare(props.fen, rookMove.from),
          props.from,
        );
  const position = (square: string) => {
    const index = squareIndex(square);
    return `translate(${(index % 8) * 100}%, ${Math.floor(index / 8) * 100}%)`;
  };
  const atTarget = reduced || phase === "type" || phase === "hold";

  return (
    <div className="boardloop" ref={hostRef} data-testid="board-loop">
      <Board fen={baseFen} lastMove={{ from: props.from, to: props.to }} />
      <div className="boardloop-layer" aria-hidden="true">
        {victim !== null && !atTarget ? (
          <span
            className="boardloop-piece"
            style={{ transform: position(victimSquare) }}
          >
            <PieceGlyph type={victim.type} side={victim.side} />
          </span>
        ) : null}
        {capture && phase === "type" && !reduced ? (
          <span
            className="boardloop-burn"
            style={{ transform: position(victimSquare) }}
          />
        ) : null}
        {(phase === "erase" || phase === "type") && !reduced ? (
          <span className="boardloop-sweep" />
        ) : null}
        {phase === "type" && !reduced ? (
          <span
            className="boardloop-piece"
            style={{ transform: position(props.to) }}
          >
            <i className="boardloop-caret">▊</i>
          </span>
        ) : null}
        <span
          className={[
            "boardloop-piece",
            phase === "erase" && !reduced ? "erasing" : "",
            phase === "type" && !reduced ? "typing" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ transform: position(atTarget ? props.to : props.from) }}
        >
          <PieceGlyph type={mover.type} side={mover.side} />
        </span>
        {rookMove !== null && rook !== null ? (
          <span
            className={[
              "boardloop-piece",
              phase === "erase" && !reduced ? "erasing" : "",
              phase === "type" && !reduced ? "typing" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              transform: position(atTarget ? rookMove.to : rookMove.from),
            }}
          >
            <PieceGlyph type={rook.type} side={rook.side} />
          </span>
        ) : null}
      </div>
    </div>
  );
}
