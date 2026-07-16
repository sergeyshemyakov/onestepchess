import { Chess } from "chess.js";
import { CoreError, type Move, STARTING_FEN, type Uci } from "../types.js";
import type { ChessState, NormalizeResult } from "./adapter.js";

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function applyUci(chess: Chess, uci: Uci): void {
  if (!UCI_PATTERN.test(uci)) {
    throw new CoreError("CORRUPT_HISTORY", `invalid UCI in history: ${uci}`);
  }

  try {
    chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci.length === 5 ? { promotion: uci[4] } : {}),
    });
  } catch {
    throw new CoreError("CORRUPT_HISTORY", `illegal UCI in history: ${uci}`);
  }
}

function legalMovesFor(state: ChessState): readonly Move[] {
  const chess = new Chess(STARTING_FEN);
  for (const uci of state.history) {
    applyUci(chess, uci);
  }

  return chess
    .moves({ verbose: true })
    .map((move) => ({
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      san: move.san,
    }))
    .sort((left, right) => left.uci.localeCompare(right.uci));
}

function stripSanSuffixes(value: string): string {
  let stripped = value.trim();
  let previous = "";
  while (stripped !== previous) {
    previous = stripped;
    stripped = stripped
      .replace(/[+#?!]+$/u, "")
      .replace(/\s*e\.?p\.?$/iu, "")
      .trim();
  }
  return stripped.replace(/^0-0-0$/u, "O-O-O").replace(/^0-0$/u, "O-O");
}

type SanShape = {
  readonly castle?: "O-O" | "O-O-O";
  readonly piece?: "K" | "Q" | "R" | "B" | "N";
  readonly target?: string;
  readonly promotion?: "Q" | "R" | "B" | "N";
  readonly fromFile?: string;
  readonly fromRank?: string;
  readonly captureHint?: boolean;
};

function parseSanShape(input: string): SanShape | null {
  const san = stripSanSuffixes(input);
  if (san === "O-O" || san === "O-O-O") {
    return { castle: san };
  }

  const match = /^(.*?)([a-h][1-8])(?:=([QRBN]))?$/u.exec(san);
  if (!match?.[2]) {
    return null;
  }

  let prefix = match[1] ?? "";
  let piece: SanShape["piece"];
  const first = prefix[0];
  if (
    first === "K" ||
    first === "Q" ||
    first === "R" ||
    first === "B" ||
    first === "N"
  ) {
    piece = first;
    prefix = prefix.slice(1);
  }

  const captureHint = prefix.includes("x");
  prefix = prefix.replace("x", "");
  if (prefix.includes("x") || prefix.length > 2) {
    return null;
  }

  let fromFile: string | undefined;
  let fromRank: string | undefined;
  for (const hint of prefix) {
    if (/^[a-h]$/u.test(hint) && fromFile === undefined) {
      fromFile = hint;
    } else if (/^[1-8]$/u.test(hint) && fromRank === undefined) {
      fromRank = hint;
    } else {
      return null;
    }
  }

  const promotion = match[3] as SanShape["promotion"] | undefined;
  return {
    ...(piece === undefined ? {} : { piece }),
    target: match[2],
    ...(promotion === undefined ? {} : { promotion }),
    ...(fromFile === undefined ? {} : { fromFile }),
    ...(fromRank === undefined ? {} : { fromRank }),
    captureHint,
  };
}

function matchesShape(move: Move, shape: SanShape): boolean {
  const canonical = stripSanSuffixes(move.san);
  if (shape.castle !== undefined) {
    return canonical === shape.castle;
  }
  if (canonical === "O-O" || canonical === "O-O-O") {
    return false;
  }

  const first = canonical[0];
  const piece =
    first === "K" ||
    first === "Q" ||
    first === "R" ||
    first === "B" ||
    first === "N"
      ? first
      : undefined;
  const promotion = move.uci[4]?.toUpperCase();
  return (
    piece === shape.piece &&
    move.uci.slice(2, 4) === shape.target &&
    promotion === shape.promotion &&
    (shape.fromFile === undefined || move.uci[0] === shape.fromFile) &&
    (shape.fromRank === undefined || move.uci[1] === shape.fromRank) &&
    (!shape.captureHint || canonical.includes("x"))
  );
}

export function normalizeLegalMove(
  legalMoves: readonly Move[],
  input: string,
): NormalizeResult {
  const trimmed = input.trim();
  const lowercase = trimmed.toLowerCase();
  if (UCI_PATTERN.test(lowercase)) {
    const move = legalMoves.find((candidate) => candidate.uci === lowercase);
    return move === undefined
      ? { ok: false, reason: "illegal", legalMoves }
      : { ok: true, move };
  }

  const shape = parseSanShape(trimmed);
  if (shape === null) {
    return { ok: false, reason: "illegal", legalMoves };
  }

  const matches = legalMoves.filter((move) => matchesShape(move, shape));
  if (matches.length === 1 && matches[0] !== undefined) {
    return { ok: true, move: matches[0] };
  }
  return {
    ok: false,
    reason: matches.length > 1 ? "ambiguous" : "illegal",
    legalMoves,
  };
}

export function normalizeMove(
  state: ChessState,
  input: string,
): NormalizeResult {
  return normalizeLegalMove(legalMovesFor(state), input);
}
