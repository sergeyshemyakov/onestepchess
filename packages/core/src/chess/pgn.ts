import { Chess } from "chess.js";
import {
  CoreError,
  type GameResult,
  STARTING_FEN,
  type Uci,
} from "../types.js";

export type PgnArgs = {
  readonly history: readonly Uci[];
  readonly result: GameResult;
  readonly tags?: Readonly<Record<string, string>>;
};

const RESULT_TOKENS: Readonly<Record<GameResult, string>> = {
  white: "1-0",
  black: "0-1",
  draw: "1/2-1/2",
  aborted: "*",
};
const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function escapeTag(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function toPgn({ history, result, tags }: PgnArgs): string {
  const chess = new Chess(STARTING_FEN);
  const sans: string[] = [];
  for (const uci of history) {
    if (!UCI_PATTERN.test(uci)) {
      throw new CoreError("CORRUPT_HISTORY", `invalid UCI in history: ${uci}`);
    }
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        ...(uci.length === 5 ? { promotion: uci[4] } : {}),
      });
      sans.push(move.san);
    } catch {
      throw new CoreError("CORRUPT_HISTORY", `illegal UCI in history: ${uci}`);
    }
  }

  const turns: string[] = [];
  for (let index = 0; index < sans.length; index += 2) {
    const white = sans[index];
    if (white === undefined) {
      break;
    }
    const black = sans[index + 1];
    turns.push(
      black === undefined
        ? `${index / 2 + 1}. ${white}`
        : `${index / 2 + 1}. ${white} ${black}`,
    );
  }
  const movetext = [...turns, RESULT_TOKENS[result]].join(" ");
  const tagLines = Object.entries(tags ?? {}).map(
    ([key, value]) => `[${key} "${escapeTag(value)}"]`,
  );
  return tagLines.length === 0
    ? movetext
    : `${tagLines.join("\n")}\n\n${movetext}`;
}
