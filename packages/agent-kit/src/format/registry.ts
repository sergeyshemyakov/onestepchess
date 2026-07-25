import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimView, ReplayView } from "../schemas.js";

export type ClaimFormat = "fen" | "ascii" | "unicode" | "json";
export type ReplayFormat = ClaimFormat | "pgn" | "uci" | "san";
export type Rendered = {
  readonly format: string;
  readonly mime: string;
  readonly ext: string;
  readonly content: string;
};

type Formatter = (input: unknown, options?: unknown) => Rendered;
const claimFormatters = new Map<string, Formatter>();
const replayFormatters = new Map<string, Formatter>();

const asciiPieces: Record<string, string> = {
  p: "p",
  n: "n",
  b: "b",
  r: "r",
  q: "q",
  k: "k",
  P: "P",
  N: "N",
  B: "B",
  R: "R",
  Q: "Q",
  K: "K",
};
const unicodePieces: Record<string, string> = {
  K: "♔",
  Q: "♕",
  R: "♖",
  B: "♗",
  N: "♘",
  P: "♙",
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

function board(fen: string, pieces: Record<string, string>, empty: string) {
  const placement = fen.split(" ")[0] ?? "";
  const ranks = placement.split("/");
  if (ranks.length !== 8) throw new Error("invalid FEN placement");
  const lines = ranks.map((rank, index) => {
    const cells: string[] = [];
    for (const token of rank) {
      if (/^[1-8]$/.test(token)) {
        cells.push(...Array.from({ length: Number(token) }, () => empty));
      } else {
        const piece = pieces[token];
        if (piece === undefined) throw new Error("invalid FEN piece");
        cells.push(piece);
      }
    }
    if (cells.length !== 8) throw new Error("invalid FEN rank");
    return `${8 - index} ${cells.join(" ")}`;
  });
  return [...lines, "  a b c d e f g h"].join("\n");
}

function cents(microUsdc: number): string {
  const whole = Math.floor(microUsdc / 10_000);
  const fraction = String(microUsdc % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction}`;
}

function caption(view: ClaimView, now: number): string {
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(view.deadline) - now) / 1_000),
  );
  return `you play ${view.yourSide} · stake ${cents(view.stakeMicroUsdc)}¢ · ${seconds}s left`;
}

function claimBoard(
  view: ClaimView,
  kind: "ascii" | "unicode",
  options?: { readonly now?: number },
): Rendered {
  const content = board(
    view.fen,
    kind === "ascii" ? asciiPieces : unicodePieces,
    kind === "ascii" ? "." : "·",
  );
  return {
    format: kind,
    mime: "text/plain",
    ext: "txt",
    content:
      options?.now === undefined
        ? content
        : `${content}\n\n${caption(view, options.now)}`,
  };
}

function replaySan(replay: ReplayView): string {
  const chunks: string[] = [];
  for (const ply of replay.plies) {
    const moveNumber = Math.ceil(ply.ply / 2);
    if (ply.side === "white") {
      chunks.push(`${moveNumber}. ${ply.move.san}`);
    } else if (chunks.length === 0 || replay.plies[0]?.side === "black") {
      chunks.push(`${moveNumber}. ... ${ply.move.san}`);
    } else {
      const index = chunks.length - 1;
      chunks[index] = `${chunks[index]} ${ply.move.san}`;
    }
  }
  const result =
    replay.result === "white"
      ? "1-0"
      : replay.result === "black"
        ? "0-1"
        : replay.result === "draw"
          ? "1/2-1/2"
          : "*";
  return `${chunks.join(" ")} ${result}`.trim();
}

claimFormatters.set("fen", (input) => ({
  format: "fen",
  mime: "text/plain",
  ext: "fen",
  content: (input as ClaimView).fen,
}));
claimFormatters.set("json", (input) => ({
  format: "json",
  mime: "application/json",
  ext: "json",
  content: JSON.stringify(input, null, 2),
}));
claimFormatters.set("ascii", (input, options) =>
  claimBoard(
    input as ClaimView,
    "ascii",
    options as { readonly now?: number } | undefined,
  ),
);
claimFormatters.set("unicode", (input, options) =>
  claimBoard(
    input as ClaimView,
    "unicode",
    options as { readonly now?: number } | undefined,
  ),
);

replayFormatters.set("fen", (input) => ({
  format: "fen",
  mime: "text/plain",
  ext: "fen",
  content: (input as ReplayView).plies.at(-1)?.fenAfter ?? "",
}));
replayFormatters.set("json", (input) => ({
  format: "json",
  mime: "application/json",
  ext: "json",
  content: JSON.stringify(input, null, 2),
}));
replayFormatters.set("ascii", (input) => {
  const replay = input as ReplayView;
  return {
    format: "ascii",
    mime: "text/plain",
    ext: "txt",
    content: board(
      replay.plies.at(-1)?.fenAfter ?? "8/8/8/8/8/8/8/8",
      asciiPieces,
      ".",
    ),
  };
});
replayFormatters.set("unicode", (input) => {
  const replay = input as ReplayView;
  return {
    format: "unicode",
    mime: "text/plain",
    ext: "txt",
    content: board(
      replay.plies.at(-1)?.fenAfter ?? "8/8/8/8/8/8/8/8",
      unicodePieces,
      "·",
    ),
  };
});
replayFormatters.set("pgn", (input) => ({
  format: "pgn",
  mime: "application/x-chess-pgn",
  ext: "pgn",
  content: (input as ReplayView).pgn,
}));
replayFormatters.set("uci", (input) => ({
  format: "uci",
  mime: "text/plain",
  ext: "txt",
  content: (input as ReplayView).plies.map((ply) => ply.move.uci).join(" "),
}));
replayFormatters.set("san", (input) => ({
  format: "san",
  mime: "text/plain",
  ext: "txt",
  content: replaySan(input as ReplayView),
}));

export function registerFormatter(
  kind: "claim" | "replay",
  name: string,
  formatter: Formatter,
): void {
  (kind === "claim" ? claimFormatters : replayFormatters).set(name, formatter);
}

export function renderClaim(
  view: ClaimView,
  format: ClaimFormat | (string & {}),
  options?: { readonly now?: number },
): Rendered {
  const formatter = claimFormatters.get(format);
  if (formatter === undefined)
    throw new Error(`unknown claim format: ${format}`);
  return formatter(view, options);
}

export function renderReplay(
  replay: ReplayView,
  format: ReplayFormat | (string & {}),
): Rendered {
  const formatter = replayFormatters.get(format);
  if (formatter === undefined) {
    throw new Error(`unknown replay format: ${format}`);
  }
  return formatter(replay);
}

export function writeClaimFiles(view: ClaimView, directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `claim-${view.claimId}.txt`),
    renderClaim(view, "ascii").content,
  );
  writeFileSync(
    join(directory, `claim-${view.claimId}.fen`),
    renderClaim(view, "fen").content,
  );
}

export function writeReplayFiles(replay: ReplayView, directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `game-${replay.gameId}.pgn`),
    renderReplay(replay, "pgn").content,
  );
}
