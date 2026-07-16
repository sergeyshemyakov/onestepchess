import { Chess, validateFen } from "chess.js";
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

const FEN_FACT_CACHE_SIZE = 4_096;
const fenFactCache = new Map<
  string,
  { readonly side: Side; readonly pieces: number }
>();

function fenFacts(fen: string): {
  readonly side: Side;
  readonly pieces: number;
} {
  const cached = fenFactCache.get(fen);
  if (cached !== undefined) {
    fenFactCache.delete(fen);
    fenFactCache.set(fen, cached);
    return cached;
  }
  const turn = fen.split(" ")[1];
  if ((turn !== "w" && turn !== "b") || !validateFen(fen).ok) {
    throw new CoreError("CONTRACT", "invalid FEN");
  }
  const board = fen.split(" ")[0] ?? "";
  let pieces = 0;
  for (const char of board) {
    if ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z")) {
      pieces += 1;
    }
  }
  const facts = { side: turn === "w" ? "white" : "black", pieces } as const;
  fenFactCache.set(fen, facts);
  while (fenFactCache.size > FEN_FACT_CACHE_SIZE) {
    const oldest = fenFactCache.keys().next().value;
    if (oldest === undefined) break;
    fenFactCache.delete(oldest);
  }
  return facts;
}

export function sideToMove(fen: string): Side {
  // Eligibility revisits each live FEN for many actors, so bounded memoization
  // keeps validation out of the matchmaking hot path.
  return fenFacts(fen).side;
}

export function pieceCount(fen: string): number {
  return fenFacts(fen).pieces;
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
  const moveCache = new Map<string, readonly Move[]>();
  const keyFor = (history: readonly Uci[]) => history.join("\u0000");

  const rememberIn = <T>(
    store: Map<string, T>,
    key: string,
    value: T,
  ): void => {
    if (cacheSize === 0) {
      return;
    }
    store.delete(key);
    store.set(key, value);
    while (store.size > cacheSize) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      store.delete(oldest);
    }
  };

  const remember = (key: string, chess: Chess): void => {
    rememberIn(cache, key, chess);
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

  const movesFor = (state: ChessState): readonly Move[] => {
    const key = keyFor(state.history);
    const cached = moveCache.get(key);
    if (cached !== undefined) {
      moveCache.delete(key);
      moveCache.set(key, cached);
      return cached;
    }
    const moves = domainMoves(obtain(state));
    rememberIn(moveCache, key, moves);
    return moves;
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
      return movesFor(state);
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
      // One cached legal-move generation decides both mate kinds instead of
      // chess.js regenerating moves inside isCheckmate and isStalemate.
      if (movesFor(state).length === 0) {
        if (chess.isCheck()) {
          return {
            over: true,
            result: opposite(sideToMove(state.fen)),
            termination: "checkmate",
          };
        }
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
      return normalizeLegalMove(movesFor(state), input);
    },
    pieceCount,
  };
}
