import { memo } from "react";
import type { PieceType, Side } from "../lib/fen.js";

// 16×16 bitmaps ("#" = lit pixel) are the single source for both sides:
// white renders filled, black hollow (edge pixels only) — the locked
// fill-vs-hollow side contrast (§8.2, colorblind-safe).
const PIX: Record<PieceType, readonly string[]> = {
  p: [
    "................",
    "................",
    "................",
    "......####......",
    ".....######.....",
    ".....######.....",
    ".....######.....",
    "......####......",
    "......####......",
    ".....######.....",
    ".....######.....",
    "......####......",
    "....########....",
    "...##########...",
    "...##########...",
    "................",
  ],
  r: [
    "................",
    "..##.##..##.##..",
    "..##.##..##.##..",
    "..############..",
    "..############..",
    "...##########...",
    "....########....",
    "....########....",
    "....########....",
    "....########....",
    "....########....",
    "....########....",
    "...##########...",
    "..############..",
    ".##############.",
    "................",
  ],
  n: [
    "................",
    "......####......",
    ".....######.....",
    "....########....",
    "...##########...",
    "..############..",
    "..###..#######..",
    ".###...#######..",
    ".##....######...",
    "......#######...",
    ".....#######....",
    "....########....",
    "....#########...",
    "...##########...",
    "..############..",
    "................",
  ],
  b: [
    "................",
    ".......##.......",
    "......####......",
    ".....######.....",
    ".....###.##.....",
    ".....##.###.....",
    "......####......",
    ".....######.....",
    ".....######.....",
    "......####......",
    "......####......",
    ".....######.....",
    "....########....",
    "...##########...",
    "...##########...",
    "................",
  ],
  q: [
    "................",
    "..#....##....#..",
    ".###..####..###.",
    "..#...####...#..",
    "..##..####..##..",
    "..############..",
    "..############..",
    "...##########...",
    "....########....",
    ".....######.....",
    ".....######.....",
    "......####......",
    ".....######.....",
    "....########....",
    "..############..",
    "................",
  ],
  k: [
    ".......##.......",
    ".....######.....",
    ".......##.......",
    ".......##.......",
    "....########....",
    "...##########...",
    "..############..",
    "..############..",
    "..############..",
    "...##########...",
    "....########....",
    ".....######.....",
    ".....######.....",
    "....########....",
    "..############..",
    "................",
  ],
};

// Pixel homage draft of the Algorand mark (mockups W1) — not the official
// geometry.
const ALGO_MARK: readonly string[] = [
  ".........###....",
  "........####....",
  "........####....",
  ".......######...",
  "......#########.",
  "......###.#####.",
  ".....###...###..",
  ".....###..####..",
  "....###...####..",
  "...####..#####..",
  "...###...######.",
  "..####..###.###.",
  "..###..####.###.",
  ".###...###...##.",
  ".###..###....###",
  "###...###....###",
];

function bitmapPath(rows: readonly string[], hollow: boolean): string {
  const on = (r: number, c: number): boolean =>
    r >= 0 && r < 16 && c >= 0 && c < 16 && rows[r]?.[c] === "#";
  let d = "";
  for (let r = 0; r < 16; r += 1) {
    for (let c = 0; c < 16; c += 1) {
      if (!on(r, c)) continue;
      const edge = !(
        on(r - 1, c) &&
        on(r + 1, c) &&
        on(r, c - 1) &&
        on(r, c + 1)
      );
      if (hollow && !edge) continue;
      d += `M${c} ${r}h1v1h-1z`;
    }
  }
  return d;
}

// Path strings are computed once per (type, side) — piece rendering is a
// cached-path clone no matter how often squares re-render.
const pathCache = new Map<string, string>();

function cachedPath(
  rows: readonly string[],
  key: string,
  hollow: boolean,
): string {
  const cacheKey = `${key}|${hollow ? "h" : "f"}`;
  let d = pathCache.get(cacheKey);
  if (d === undefined) {
    d = bitmapPath(rows, hollow);
    pathCache.set(cacheKey, d);
  }
  return d;
}

export const PieceGlyph = memo(function PieceGlyph(props: {
  readonly type: PieceType;
  readonly side: Side;
}) {
  return (
    <svg className="pc" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={cachedPath(PIX[props.type], props.type, props.side === "black")}
        fill="currentColor"
      />
    </svg>
  );
});

export function KnightMark(props: { readonly size?: number }) {
  const size = props.size ?? 22;
  return (
    <svg
      className="pc"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path d={cachedPath(PIX.n, "n", false)} fill="currentColor" />
    </svg>
  );
}

export function AlgorandMark(props: { readonly size?: number }) {
  const size = props.size ?? 15;
  return (
    <svg
      className="pc"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path d={cachedPath(ALGO_MARK, "algo", false)} fill="currentColor" />
    </svg>
  );
}
