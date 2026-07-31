import { memo, useEffect, useMemo, useRef } from "react";
import {
  FILES,
  type Piece,
  parseFenBoard,
  squareIndex,
  squareName,
} from "../lib/fen.js";
import { castlingRookMove } from "./castling.js";
import { PieceGlyph } from "./pieces.jsx";
import { useSquareSize } from "./useSquareSize.js";

export const MIN_BOARD_PX = 320;
export const MAX_BOARD_PX = 520;
export const MOBILE_PADDING_PX = 12;

/** Board width for a viewport — squares stay ≥ 44px at the touch
 * breakpoints (420px → 49.5px squares) and the board never drops
 * below 320px (§8.2, D13). */
export function boardPxForViewport(viewportWidth: number): number {
  return Math.max(
    MIN_BOARD_PX,
    Math.min(MAX_BOARD_PX, viewportWidth - 2 * MOBILE_PADDING_PX),
  );
}

export type BoardFx = {
  /** "type": scanline type-in — source erases, a beam sweeps, target types
   * in. "glide": the piece slides source → target (UI suggestions). */
  readonly kind: "type" | "glide";
  readonly from: string;
  readonly to: string;
  readonly capture?: boolean;
  /** monotonically increasing — a new value plays the effect once */
  readonly seq: number;
};

/** Test-only render probe: proves the 64 memoized squares diff correctly
 * (only changed squares re-render between FENs). */
export const squareRenderProbe: {
  onRender: ((square: string) => void) | null;
} = { onRender: null };

type SquareProps = {
  readonly index: number;
  readonly piece: Piece | null;
  readonly selected: boolean;
  readonly target: boolean;
  readonly captureTarget: boolean;
  readonly hint: boolean;
  readonly check: boolean;
  readonly epVictim: boolean;
  readonly epTarget: boolean;
  readonly interactive: boolean;
  readonly coords: boolean;
  readonly onTap: ((square: string) => void) | null;
};

function squareEqual(a: SquareProps, b: SquareProps): boolean {
  return (
    a.piece?.type === b.piece?.type &&
    a.piece?.side === b.piece?.side &&
    a.selected === b.selected &&
    a.target === b.target &&
    a.captureTarget === b.captureTarget &&
    a.hint === b.hint &&
    a.check === b.check &&
    a.epVictim === b.epVictim &&
    a.epTarget === b.epTarget &&
    a.interactive === b.interactive &&
    a.onTap === b.onTap
  );
}

const Square = memo(function Square(props: SquareProps) {
  const name = squareName(props.index);
  squareRenderProbe.onRender?.(name);
  const dark = (Math.floor(props.index / 8) + (props.index % 8)) % 2 === 1;
  const className = [
    "sq",
    dark ? "d" : "l",
    props.selected ? "sel" : "",
    props.hint ? "hint" : "",
    props.check ? "chk" : "",
    props.epVictim ? "ep" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const marks = (
    <>
      {props.piece === null ? null : (
        <PieceGlyph type={props.piece.type} side={props.piece.side} />
      )}
      {props.target ? (
        <span
          className={[
            "dot",
            // En passant lands on an empty square but is still a capture —
            // without the ring it masquerades as a quiet move.
            props.captureTarget || props.epTarget ? "cap" : "",
            props.epTarget ? "ep" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        />
      ) : null}
      {props.coords && props.index % 8 === 0 ? (
        <i className="coord r">{8 - Math.floor(props.index / 8)}</i>
      ) : null}
      {props.coords && Math.floor(props.index / 8) === 7 ? (
        <i className="coord f">{FILES[props.index % 8]}</i>
      ) : null}
    </>
  );
  if (!props.interactive) {
    return (
      <div className={className} data-square={name}>
        {marks}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      data-square={name}
      aria-label={`square ${name}`}
      onClick={() => props.onTap?.(name)}
    >
      {marks}
    </button>
  );
}, squareEqual);

export type BoardProps = {
  readonly fen: string;
  readonly legalTargets?: readonly string[];
  readonly selected?: string | null;
  readonly lastMove?: { readonly from: string; readonly to: string } | null;
  /** King square of the side in check, if any (display-only). */
  readonly checkSquare?: string | null;
  /** Pawns capturable en passant — marked persistently. */
  readonly epVictims?: readonly string[];
  /** En passant landing squares — dots render as capture rings. */
  readonly epTargets?: readonly string[];
  readonly onSquareTap?: (square: string) => void;
  readonly interactive?: boolean;
  readonly coords?: boolean;
  readonly fx?: BoardFx | null;
};

function playFx(layer: HTMLDivElement, fx: BoardFx): () => void {
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return () => undefined;
  const board = layer.parentElement;
  const glyph = board?.querySelector<SVGElement>(
    `[data-square="${fx.to}"] svg.pc`,
  );
  if (glyph === null || glyph === undefined) return () => undefined;
  const rookMove = castlingRookMove(fx.from, fx.to);
  const rookGlyph =
    rookMove === null
      ? null
      : (board?.querySelector<SVGElement>(
          `[data-square="${rookMove.to}"] svg.pc`,
        ) ?? null);
  const fromIndex = squareIndex(fx.from);
  const toIndex = squareIndex(fx.to);
  const at = (index: number): { readonly x: number; readonly y: number } => ({
    x: (index % 8) * 100,
    y: Math.floor(index / 8) * 100,
  });
  const from = at(fromIndex);
  const to = at(toIndex);
  const actors: HTMLElement[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const clone = (
    actorGlyph: SVGElement,
    x: number,
    y: number,
    className: string,
  ): HTMLElement => {
    const holder = document.createElement("div");
    holder.className = `fxpc ${className}`;
    holder.style.width = "12.5%";
    holder.style.height = "12.5%";
    holder.style.transform = `translate(${x}%, ${y}%)`;
    holder.appendChild(actorGlyph.cloneNode(true));
    layer.appendChild(holder);
    actors.push(holder);
    return holder;
  };
  if (fx.capture === true) {
    clone(glyph, to.x, to.y, "fx-burn");
  }
  const target = board?.querySelector<HTMLElement>(`[data-square="${fx.to}"]`);
  const commitFlash = () => {
    target?.classList.add("flash");
    board?.classList.add("commitflash");
    timers.push(
      setTimeout(() => {
        target?.classList.remove("flash");
        board?.classList.remove("commitflash");
      }, 320),
    );
  };
  if (fx.kind === "glide") {
    const gliders = [{ node: clone(glyph, from.x, from.y, "fx-glide"), to }];
    const hiddenGlyphs = [glyph];
    if (rookMove !== null && rookGlyph !== null) {
      gliders.push({
        node: clone(
          rookGlyph,
          at(squareIndex(rookMove.from)).x,
          at(squareIndex(rookMove.from)).y,
          "fx-glide",
        ),
        to: at(squareIndex(rookMove.to)),
      });
      hiddenGlyphs.push(rookGlyph);
    }
    for (const hidden of hiddenGlyphs) hidden.style.visibility = "hidden";
    // Double rAF: the clone's start position must be committed before the
    // transition begins, otherwise the glide gets skipped (UI suggestions).
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        for (const glider of gliders) {
          glider.node.style.transform = `translate(${glider.to.x}%, ${glider.to.y}%)`;
        }
      });
    });
    timers.push(
      setTimeout(() => {
        for (const hidden of hiddenGlyphs) hidden.style.visibility = "";
        for (const node of actors) node.remove();
        commitFlash();
      }, 340),
    );
    return () => {
      cancelAnimationFrame(raf);
      for (const timer of timers) clearTimeout(timer);
      for (const node of actors) node.remove();
      for (const hidden of hiddenGlyphs) hidden.style.visibility = "";
      target?.classList.remove("flash");
      board?.classList.remove("commitflash");
    };
  }
  const eraser = clone(glyph, from.x, from.y, "fx-erase");
  const sweep = document.createElement("div");
  sweep.className = "fx-sweep";
  layer.appendChild(sweep);
  actors.push(sweep);
  glyph.style.visibility = "hidden";
  const caret = document.createElement("span");
  caret.className = "fx-caret";
  caret.textContent = "▊";
  timers.push(
    setTimeout(() => {
      eraser.remove();
      glyph.style.visibility = "";
      glyph.classList.add("fx-typein");
      target?.appendChild(caret);
      timers.push(
        setTimeout(() => {
          caret.remove();
          glyph.classList.remove("fx-typein");
          for (const node of actors) node.remove();
          commitFlash();
        }, 380),
      );
    }, 200),
  );
  return () => {
    for (const timer of timers) clearTimeout(timer);
    for (const node of actors) node.remove();
    caret.remove();
    glyph.style.visibility = "";
    glyph.classList.remove("fx-typein");
    target?.classList.remove("flash");
    board?.classList.remove("commitflash");
  };
}

export function Board(props: BoardProps) {
  const pieces = useMemo(() => parseFenBoard(props.fen), [props.fen]);
  const interactive = props.interactive ?? false;
  const coords = props.coords ?? false;
  const targets = useMemo(
    () => new Set(props.legalTargets ?? []),
    [props.legalTargets],
  );
  const epVictims = useMemo(
    () => new Set(props.epVictims ?? []),
    [props.epVictims],
  );
  const epTargets = useMemo(
    () => new Set(props.epTargets ?? []),
    [props.epTargets],
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const lastFxSeq = useRef(0);
  useSquareSize(hostRef);

  useEffect(() => {
    const layer = fxRef.current;
    const fx = props.fx;
    if (layer === null) return;
    if (fx === null || fx === undefined) {
      lastFxSeq.current = 0;
      return;
    }
    if (fx.seq === lastFxSeq.current) return;
    lastFxSeq.current = fx.seq;
    return playFx(layer, fx);
  }, [props.fx]);

  const onTap = interactive ? (props.onSquareTap ?? null) : null;
  const lastMove = props.lastMove ?? null;

  return (
    <div className="board" ref={hostRef} data-testid="board">
      {pieces.map((piece, index) => {
        const name = squareName(index);
        return (
          <Square
            key={name}
            index={index}
            piece={piece}
            selected={props.selected === name}
            target={targets.has(name)}
            captureTarget={targets.has(name) && piece !== null}
            hint={
              lastMove !== null &&
              (lastMove.from === name || lastMove.to === name)
            }
            check={props.checkSquare === name}
            epVictim={epVictims.has(name)}
            epTarget={targets.has(name) && epTargets.has(name)}
            interactive={interactive}
            coords={coords}
            onTap={onTap}
          />
        );
      })}
      <div className="fxlayer" ref={fxRef} />
    </div>
  );
}
