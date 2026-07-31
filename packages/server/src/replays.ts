import {
  type GameResult,
  gameRulesSchema,
  materialPoints,
  type Termination,
} from "@onestepchess/core";
import { eq } from "drizzle-orm";
import type { Db } from "./db/open.js";
import { schema } from "./db/open.js";

export type StoredReplayPly = {
  readonly ply: number;
  readonly side: "white" | "black";
  readonly move: { readonly uci: string; readonly san: string };
  readonly fenAfter: string;
  readonly authorAddress: string;
  readonly stakeMicroUsdc: number;
  readonly demo: boolean;
};

export type StoredReplay = {
  readonly plies: readonly StoredReplayPly[];
  readonly pgn: string;
};

export type RepetitionAdjudication = {
  readonly whiteMaterialPoints: number;
  readonly blackMaterialPoints: number;
  readonly winMargin: number;
};

export function repetitionAdjudicationFor(game: {
  readonly fen: string;
  readonly result: GameResult | null;
  readonly termination: Termination | null;
  readonly rulesJson: string;
}): RepetitionAdjudication | null {
  if (
    game.termination !== "threefold" ||
    (game.result !== "white" && game.result !== "black")
  ) {
    return null;
  }
  const material = materialPoints(game.fen);
  const rules = gameRulesSchema.parse(JSON.parse(game.rulesJson));
  return {
    whiteMaterialPoints: material.white,
    blackMaterialPoints: material.black,
    winMargin: rules.REPETITION_WIN_MARGIN,
  };
}

type TerminalReplayGame = typeof schema.games.$inferSelect & {
  readonly status: "finished" | "aborted";
  readonly replayJson: string;
};

export function findTerminalReplayGame(
  db: Db,
  gameId: string,
): TerminalReplayGame | null {
  const game = db
    .select()
    .from(schema.games)
    .where(eq(schema.games.id, gameId))
    .get();
  if (
    game === undefined ||
    (game.status !== "finished" && game.status !== "aborted") ||
    game.replayJson === null
  ) {
    return null;
  }
  return game as TerminalReplayGame;
}

export function parseStoredReplay(replayJson: string): StoredReplay {
  return JSON.parse(replayJson) as StoredReplay;
}
