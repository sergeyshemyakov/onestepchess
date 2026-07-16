import { Chess } from "chess.js";
import type { CoreConfig } from "../config.js";
import {
  CoreError,
  type Move,
  opposite,
  type Phase,
  type Side,
  STARTING_FEN,
  type Uci,
} from "../types.js";
import { normalizeLegalMove } from "./normalize.js";
import type { TurnGame } from "./port.js";

export type ChessState = {
  readonly fen: string;
  readonly history: readonly Uci[];
};

export type NormalizeResult =
  | { readonly ok: true; readonly move: Move }
  | {
      readonly ok: false;
      readonly reason: "illegal" | "ambiguous";
      readonly legalMoves: readonly Move[];
    };

export interface ChessGame extends TurnGame<ChessState, Move> {
  fromHistory(history: readonly Uci[]): ChessState;
  normalizeMove(state: ChessState, input: string): NormalizeResult;
  pieceCount(fen: string): number;
}

type ChessConfig = Pick<
  CoreConfig,
  "ENDSPIEL_PLY" | "ENDSPIEL_PIECES" | "MAX_PLIES"
>;

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function moveChess(
  chess: Chess,
  uci: Uci,
  errorCode: "CORRUPT_HISTORY" | "ILLEGAL_APPLY",
): void {
  if (!UCI_PATTERN.test(uci)) {
    throw new CoreError(errorCode, `invalid UCI: ${uci}`);
  }
  try {
    chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci.length === 5 ? { promotion: uci[4] } : {}),
    });
  } catch {
    throw new CoreError(errorCode, `illegal UCI: ${uci}`);
  }
}

function domainMoves(chess: Chess): readonly Move[] {
  return chess
    .moves({ verbose: true })
    .map((move) => ({
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      san: move.san,
    }))
    .sort((left, right) => left.uci.localeCompare(right.uci));
}

export function sideToMove(fen: string): Side {
  try {
    return new Chess(fen).turn() === "w" ? "white" : "black";
  } catch {
    throw new CoreError("CONTRACT", "invalid FEN");
  }
}

export function pieceCount(fen: string): number {
  try {
    return new Chess(fen)
      .board()
      .flat()
      .filter((piece) => piece !== null).length;
  } catch {
    throw new CoreError("CONTRACT", "invalid FEN");
  }
}

export function createChess(
  config: ChessConfig,
  options: { readonly cacheSize?: number } = {},
): ChessGame {
  const cacheSize = options.cacheSize ?? 128;
  if (!Number.isInteger(cacheSize) || cacheSize < 0) {
    throw new CoreError("CONTRACT", "cacheSize must be a nonnegative integer");
  }

  const cache = new Map<string, Chess>();
  const keyFor = (history: readonly Uci[]) => history.join("\u0000");

  const remember = (key: string, chess: Chess): void => {
    if (cacheSize === 0) {
      return;
    }
    cache.delete(key);
    cache.set(key, chess);
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  };

  const replay = (history: readonly Uci[]): Chess => {
    const chess = new Chess(STARTING_FEN);
    for (const uci of history) {
      moveChess(chess, uci, "CORRUPT_HISTORY");
    }
    return chess;
  };

  const obtain = (state: ChessState): Chess => {
    const key = keyFor(state.history);
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const chess = replay(state.history);
    remember(key, chess);
    return chess;
  };

  const fromHistory = (history: readonly Uci[]): ChessState => {
    const chess = replay(history);
    const state = { fen: chess.fen(), history: [...history] };
    remember(keyFor(history), chess);
    return state;
  };

  return {
    initial() {
      return fromHistory([]);
    },
    fromHistory,
    legalMoves(state) {
      return domainMoves(obtain(state));
    },
    apply(state, move) {
      const oldKey = keyFor(state.history);
      const chess = obtain(state);
      moveChess(chess, move.uci, "ILLEGAL_APPLY");
      cache.delete(oldKey);
      const history = [...state.history, move.uci];
      const next = { fen: chess.fen(), history };
      remember(keyFor(history), chess);
      return next;
    },
    terminal(state) {
      const chess = obtain(state);
      if (chess.isCheckmate()) {
        return {
          over: true,
          result: opposite(sideToMove(chess.fen())),
          termination: "checkmate",
        };
      }
      if (chess.isStalemate()) {
        return { over: true, result: "draw", termination: "stalemate" };
      }
      if (chess.isInsufficientMaterial()) {
        return { over: true, result: "draw", termination: "insufficient" };
      }
      if (chess.isThreefoldRepetition()) {
        return { over: true, result: "draw", termination: "threefold" };
      }
      if (chess.isDrawByFiftyMoves()) {
        return { over: true, result: "draw", termination: "fifty_move" };
      }
      if (state.history.length >= config.MAX_PLIES) {
        return { over: true, result: "draw", termination: "max_plies" };
      }
      return { over: false };
    },
    phase(state): Phase {
      return state.history.length >= config.ENDSPIEL_PLY ||
        pieceCount(state.fen) <= config.ENDSPIEL_PIECES
        ? "endspiel"
        : "normal";
    },
    encode(state) {
      return obtain(state).fen();
    },
    history(state) {
      return obtain(state)
        .history({ verbose: true })
        .map((move) => ({
          uci: `${move.from}${move.to}${move.promotion ?? ""}`,
          san: move.san,
        }));
    },
    normalizeMove(state, input) {
      return normalizeLegalMove(domainMoves(obtain(state)), input);
    },
    pieceCount,
  };
}
