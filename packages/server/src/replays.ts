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
