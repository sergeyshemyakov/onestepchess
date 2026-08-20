// Share-card SVG for the public replay (server spec F16 step 1): a 1200×630
// board snapshot in the web's green-phosphor palette, rasterized to PNG by
// cards/raster.ts. All text renders through cards/pixelfont.ts paths — never
// system fonts, which the deploy host lacks. Every dynamic value is XML-escaped
// before it reaches the markup (data-text attributes carry the rendered copy
// for tests and accessibility tooling).

import { escapeMarkup } from "../markup.js";
import { pixelTextPath } from "./pixelfont.js";

export type CardOutcome = "WON" | "LOST" | "DRAW";

export type CardData = {
  readonly gameId: string;
  readonly authorNickname: string | null;
  readonly outcome: CardOutcome;
  /** fenAfter of the rendered ply. */
  readonly fen: string;
  /** UCI of the rendered ply, for the move arrow. */
  readonly moveUci: string;
  /** Author's summed claimed→moved time in this game; null hides the line. */
  readonly thinkingTimeMs: number | null;
  /** Author's net result (payouts − stakes); the WON line renders only for a
   * positive net on a won game. */
  readonly wonMicroUsdc: number | null;
};

const WIDTH = 1200;
const HEIGHT = 630;
const BOARD = 520;
const SQUARE = BOARD / 8;
const BOARD_X = 55;
const BOARD_Y = 55;
const PANEL_X = BOARD_X + BOARD + 60;

// Web green theme (web/src/styles/tokens.css): --bg / --sql / --sqd / --ph /
// --ph-hi verbatim; DARK_TEXT approximates the color-mix(38% toward black).
const BG = "#020806";
const LIGHT = "#0b2413";
const DARK = "#051309";
const PHOSPHOR = "#41ff70";
const HI = "#c9ffd9";
const ACCENT = "#ffb347";
const DARK_TEXT = "#19612b";

// Same 16×16 bitmaps as the web boards (web/src/board/pieces.tsx): white
// renders filled, black hollow — the locked fill-vs-hollow side contrast
// (§8.2, colorblind-safe). Kept in sync by hand; server cannot import web.
const PIECE_PIX: Record<string, readonly string[]> = {
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

const piecePathCache = new Map<string, string>();

function piecePath(type: string, hollow: boolean): string {
  const key = `${type}|${hollow ? "h" : "f"}`;
  let d = piecePathCache.get(key);
  if (d === undefined) {
    d = bitmapPath(PIECE_PIX[type] as readonly string[], hollow);
    piecePathCache.set(key, d);
  }
  return d;
}

/** Parse a FEN placement field into 8 ranks (top rank first) of 8 cells. */
function parseBoard(fen: string): (string | null)[][] {
  const placement = fen.split(" ")[0] ?? "";
  const rows: (string | null)[][] = [];
  for (const rankStr of placement.split("/").slice(0, 8)) {
    const rank: (string | null)[] = [];
    for (const ch of rankStr) {
      if (ch >= "1" && ch <= "8") {
        for (let i = 0; i < Number(ch); i += 1) rank.push(null);
      } else if (PIECE_PIX[ch.toLowerCase()] !== undefined) {
        rank.push(ch);
      }
    }
    while (rank.length < 8) rank.push(null);
    rows.push(rank.slice(0, 8));
  }
  while (rows.length < 8) rows.push(new Array(8).fill(null));
  return rows;
}

type Square = { readonly file: number; readonly rank: number };

/** Row/col of a UCI square; rank '8' is board row 0. */
function uciSquares(uci: string): { from: Square; to: Square } | null {
  const match = /^([a-h])([1-8])([a-h])([1-8])/.exec(uci);
  if (match === null) return null;
  const file = (c: string) => c.charCodeAt(0) - 97;
  const row = (c: string) => 8 - Number(c);
  return {
    from: { file: file(match[1] as string), rank: row(match[2] as string) },
    to: { file: file(match[3] as string), rank: row(match[4] as string) },
  };
}

function center(square: Square): { x: number; y: number } {
  return {
    x: BOARD_X + square.file * SQUARE + SQUARE / 2,
    y: BOARD_Y + square.rank * SQUARE + SQUARE / 2,
  };
}

const MICRO_PER_CENT = 10_000;
const MICRO_PER_DOLLAR = 1_000_000;

// Amount/time formatting mirrors web/src/lib/format.ts (§4.5) by hand; the
// server cannot import web.
function trimmedFixed(
  value: number,
  maxDecimals: number,
  minDecimals = 0,
): string {
  const fixed = value.toFixed(maxDecimals);
  let end = fixed.length;
  while (end > 0 && fixed[end - 1] === "0") end -= 1;
  if (end > 0 && fixed[end - 1] === ".") end -= 1;
  const trimmed = fixed.slice(0, end);
  if (minDecimals === 0) return trimmed;
  const dot = trimmed.indexOf(".");
  const decimals = dot === -1 ? 0 : trimmed.length - dot - 1;
  if (decimals >= minDecimals) return trimmed;
  return value.toFixed(minDecimals);
}

export function formatCardMicroUsdc(microUsdc: number): string {
  const absolute = Math.abs(microUsdc);
  if (absolute >= MICRO_PER_CENT)
    return `$${trimmedFixed(absolute / MICRO_PER_DOLLAR, 6, 2)}`;
  return `${trimmedFixed(absolute / MICRO_PER_CENT, 4)} ¢`;
}

export function formatCardElapsed(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function pixelText(args: {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly fill: string;
  readonly opacity?: number;
  readonly glow?: boolean;
}): string {
  const opacity =
    args.opacity === undefined ? "" : ` opacity="${args.opacity}"`;
  const filter = args.glow === true ? ` filter="url(#glow)"` : "";
  return `<g data-text="${escapeMarkup(args.text)}"${filter}><path transform="translate(${args.x} ${args.y}) scale(${args.scale})" d="${pixelTextPath(args.text)}" fill="${args.fill}"${opacity}/></g>`;
}

export function buildCardSvg(data: CardData): string {
  const board = parseBoard(data.fen);
  const squares: string[] = [];
  const pieces: string[] = [];
  for (let r = 0; r < 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      const x = BOARD_X + f * SQUARE;
      const y = BOARD_Y + r * SQUARE;
      squares.push(
        `<rect x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="${(f + r) % 2 === 0 ? LIGHT : DARK}"/>`,
      );
      const piece = board[r]?.[f];
      if (piece == null) continue;
      const white = piece === piece.toUpperCase();
      const inset = SQUARE * 0.1;
      const scale = (SQUARE - inset * 2) / 16;
      pieces.push(
        `<path transform="translate(${x + inset} ${y + inset}) scale(${scale})" d="${piecePath(piece.toLowerCase(), !white)}" fill="${PHOSPHOR}"/>`,
      );
    }
  }

  const arrowSquares = uciSquares(data.moveUci);
  let arrow = "";
  if (arrowSquares !== null) {
    const from = center(arrowSquares.from);
    const to = center(arrowSquares.to);
    arrow = `<g opacity="0.5"><line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${ACCENT}" stroke-width="10" stroke-linecap="round" marker-end="url(#head)"/></g>`;
  }

  const title =
    data.outcome === "WON"
      ? "I WON"
      : data.outcome === "LOST"
        ? "I LOST"
        : "DRAW";

  const panel: string[] = [
    pixelText({
      text: "ONE STEP CHESS",
      x: PANEL_X,
      y: 96,
      scale: 3,
      fill: PHOSPHOR,
    }),
    pixelText({
      text: title,
      x: PANEL_X,
      y: 156,
      scale: 13,
      fill: HI,
      glow: true,
    }),
  ];
  let lineY = 318;
  if (data.thinkingTimeMs !== null) {
    panel.push(
      pixelText({
        text: `thought for: ${formatCardElapsed(data.thinkingTimeMs)}`,
        x: PANEL_X,
        y: lineY,
        scale: 4,
        fill: PHOSPHOR,
      }),
    );
    lineY += 56;
  }
  if (data.outcome === "WON" && data.wonMicroUsdc !== null) {
    panel.push(
      pixelText({
        text: `won: ${formatCardMicroUsdc(data.wonMicroUsdc)}`,
        x: PANEL_X,
        y: lineY,
        scale: 4,
        fill: PHOSPHOR,
      }),
    );
  }
  panel.push(
    pixelText({
      text: "onestepchess.xyz",
      x: PANEL_X,
      y: 540,
      scale: 4.5,
      fill: PHOSPHOR,
    }),
  );

  const byline =
    data.authorNickname === null
      ? `game ${data.gameId.replace(/^gm_/, "")}`
      : `game ${data.gameId.replace(/^gm_/, "")} · by ${data.authorNickname}`;

  // The knight mascot mirrors the web app-bar mark (KnightMark).
  const mascot = `<path transform="translate(1046 44) scale(6.2)" d="${piecePath("n", false)}" fill="${PHOSPHOR}" opacity="0.9"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <marker id="head" orient="auto" markerWidth="4" markerHeight="4" refX="4" refY="2">
      <path d="M0,0 L4,2 L0,4 Z" fill="${ACCENT}"/>
    </marker>
    <radialGradient id="crt" cx="0.5" cy="0" r="1.2">
      <stop offset="0%" stop-color="#051408"/>
      <stop offset="70%" stop-color="${BG}"/>
    </radialGradient>
    <pattern id="scan" width="2" height="4" patternUnits="userSpaceOnUse">
      <rect width="2" height="1.5" fill="#000" opacity="0.22"/>
    </pattern>
    <radialGradient id="vig" cx="0.5" cy="0.45" r="0.85">
      <stop offset="62%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.45"/>
    </radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#crt)"/>
  <rect x="${BOARD_X - 6}" y="${BOARD_Y - 6}" width="${BOARD + 12}" height="${BOARD + 12}" fill="none" stroke="${PHOSPHOR}" stroke-width="2" opacity="0.35"/>
  ${squares.join("\n  ")}
  ${arrow}
  ${pieces.join("\n  ")}
  ${mascot}
  ${panel.join("\n  ")}
  ${pixelText({ text: byline, x: BOARD_X, y: 592, scale: 2, fill: DARK_TEXT })}
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#scan)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#vig)"/>
</svg>`;
}
