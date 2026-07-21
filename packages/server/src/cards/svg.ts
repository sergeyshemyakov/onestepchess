// Share-card SVG for the public replay (server spec F16 step 1): a 1200×630
// phosphor-styled board snapshot, rasterized to PNG by cards/raster.ts. It reads
// only public-replay data (never an address); every dynamic text value is
// XML-escaped before it reaches the markup.

export type CardOutcome = "WON" | "LOST" | "DRAW";

export type CardData = {
  readonly gameName: string;
  readonly authorNickname: string | null;
  readonly outcome: CardOutcome;
  /** fenAfter of the rendered ply. */
  readonly fen: string;
  /** UCI of the rendered ply, for the move arrow. */
  readonly moveUci: string;
  readonly side: "white" | "black";
};

const WIDTH = 1200;
const HEIGHT = 630;
const BOARD = 520;
const SQUARE = BOARD / 8;
const BOARD_X = 55;
const BOARD_Y = (HEIGHT - BOARD) / 2;
const PANEL_X = BOARD_X + BOARD + 60;

const BG = "#0a0f0a";
const LIGHT = "#20361f";
const DARK = "#0f1c0f";
const PHOSPHOR = "#35e07a";
const INK_LIGHT = "#eafff0";
const INK_DARK = "#0b140b";

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const PIECE_LETTER: Record<string, string> = {
  k: "K",
  q: "Q",
  r: "R",
  b: "B",
  n: "N",
  p: "P",
};

/** Parse a FEN placement field into 8 ranks (top rank first) of 8 cells. */
function parseBoard(fen: string): (string | null)[][] {
  const placement = fen.split(" ")[0] ?? "";
  const rows: (string | null)[][] = [];
  for (const rankStr of placement.split("/").slice(0, 8)) {
    const rank: (string | null)[] = [];
    for (const ch of rankStr) {
      if (ch >= "1" && ch <= "8") {
        for (let i = 0; i < Number(ch); i += 1) rank.push(null);
      } else if (PIECE_LETTER[ch.toLowerCase()] !== undefined) {
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
      pieces.push(
        `<text x="${x + SQUARE / 2}" y="${y + SQUARE / 2}" font-family="Georgia, 'Times New Roman', serif" font-size="${SQUARE * 0.6}" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="${white ? INK_LIGHT : PHOSPHOR}" stroke="${white ? INK_DARK : "#062011"}" stroke-width="1.5" paint-order="stroke">${PIECE_LETTER[piece.toLowerCase()]}</text>`,
      );
    }
  }

  const arrowSquares = uciSquares(data.moveUci);
  let arrow = "";
  if (arrowSquares !== null) {
    const from = center(arrowSquares.from);
    const to = center(arrowSquares.to);
    arrow = `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${PHOSPHOR}" stroke-width="10" stroke-linecap="round" opacity="0.85" marker-end="url(#head)"/>`;
  }

  const outcomeColor = data.outcome === "WON" ? PHOSPHOR : INK_LIGHT;
  const author =
    data.authorNickname === null
      ? ""
      : `<text x="${PANEL_X}" y="330" font-family="Menlo, monospace" font-size="30" fill="${INK_LIGHT}" opacity="0.75">by ${xmlEscape(data.authorNickname)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <marker id="head" orient="auto" markerWidth="4" markerHeight="4" refX="2" refY="2">
      <path d="M0,0 L4,2 L0,4 Z" fill="${PHOSPHOR}"/>
    </marker>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  <rect x="${BOARD_X - 6}" y="${BOARD_Y - 6}" width="${BOARD + 12}" height="${BOARD + 12}" fill="none" stroke="${PHOSPHOR}" stroke-width="3" opacity="0.6"/>
  ${squares.join("\n  ")}
  ${arrow}
  ${pieces.join("\n  ")}
  <text x="${PANEL_X}" y="215" font-family="Menlo, monospace" font-size="34" fill="${PHOSPHOR}" letter-spacing="4">ONE STEP CHESS</text>
  <text x="${PANEL_X}" y="285" font-family="Georgia, serif" font-size="52" font-weight="700" fill="${INK_LIGHT}">${xmlEscape(data.gameName)}</text>
  ${author}
  <text x="${PANEL_X}" y="440" font-family="Menlo, monospace" font-size="120" font-weight="700" fill="${outcomeColor}">${xmlEscape(data.outcome)}</text>
  <text x="${PANEL_X}" y="490" font-family="Menlo, monospace" font-size="28" fill="${INK_LIGHT}" opacity="0.6">${data.side === "white" ? "White" : "Black"} — one move, staked in USDC</text>
</svg>`;
}
