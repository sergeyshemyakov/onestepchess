import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

// Public activity counters for the config-gated `/meta.stats` strip (server
// spec F16 step 4). Cumulative, incrementally maintained in memory, and rebuilt
// by one SQL pass at boot so a restart converges to SQL ground truth. Ships
// dark; `/meta` omits the block entirely unless PUBLIC_STATS_ENABLED.

export type PublicStatsSnapshot = {
  readonly humanMoves: number;
  readonly playersRegistered: number;
  readonly gamesFinished: number;
  readonly movesSettled: number;
};

function count(row: { n: number } | undefined): number {
  return row?.n ?? 0;
}

export class PublicStats {
  private humanMoves = 0;
  private playersRegistered = 0;
  private gamesFinished = 0;
  private movesSettled = 0;

  /** One SQL pass, from the normative F16 definitions. */
  rebuild(db: Db): void {
    this.humanMoves = count(
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.stakeEntries)
        .innerJoin(
          schema.players,
          eq(schema.players.address, schema.stakeEntries.player),
        )
        .where(eq(schema.players.kind, "human"))
        .get(),
    );
    this.playersRegistered = count(
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.players)
        .where(inArray(schema.players.kind, ["human", "agent"]))
        .get(),
    );
    this.gamesFinished = count(
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.games)
        .where(inArray(schema.games.status, ["finished", "aborted"]))
        .get(),
    );
    this.movesSettled = count(
      db.select({ n: sql<number>`count(*)` }).from(schema.stakeEntries).get(),
    );
  }

  /** A settled staked move: every one is a settled staked move; human ones also
   * count toward humanMoves (F16 definitions). */
  recordStakedMoveSettled(isHuman: boolean): void {
    this.movesSettled += 1;
    if (isHuman) this.humanMoves += 1;
  }

  /** A registered non-guest wallet (human or agent). */
  recordPlayerRegistered(): void {
    this.playersRegistered += 1;
  }

  /** A game reaching a terminal status. */
  recordGameFinished(): void {
    this.gamesFinished += 1;
  }

  snapshot(): PublicStatsSnapshot {
    return {
      humanMoves: this.humanMoves,
      playersRegistered: this.playersRegistered,
      gamesFinished: this.gamesFinished,
      movesSettled: this.movesSettled,
    };
  }
}
