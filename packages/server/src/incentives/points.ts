import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

// Points and referrals are a humans-only engagement counter — display and
// championship admission, never money (server spec F15, invariant I11). Every
// award is one immutable, uniquely-keyed `point_awards` fact; `players.points`
// is a cache recomputed from the award sum, so replays and backfills stay
// idempotent and can never double-count.

export type GameResult = "white" | "black" | "draw" | "aborted";

export type MoveWinConfig = {
  readonly pointsMove: number;
  readonly pointsWin: number;
};

export type ReferralConfig = {
  readonly referralQualifyMoves: number;
  readonly referralPoints: number;
};

type StakeEntryRow = typeof schema.stakeEntries.$inferSelect;

/** points := SUM(point_awards.amount) for one player, in the caller's txn. */
function recomputePoints(db: Db, address: string): void {
  db.update(schema.players)
    .set({
      points: sql`(SELECT COALESCE(SUM(${schema.pointAwards.amount}), 0) FROM ${schema.pointAwards} WHERE ${schema.pointAwards.player} = ${address})`,
    })
    .where(eq(schema.players.address, address))
    .run();
}

function humanPlayers(db: Db, addresses: readonly string[]): Set<string> {
  const distinct = [...new Set(addresses)];
  if (distinct.length === 0) return new Set();
  return new Set(
    db
      .select({ address: schema.players.address })
      .from(schema.players)
      .where(
        and(
          inArray(schema.players.address, distinct),
          eq(schema.players.kind, "human"),
        ),
      )
      .all()
      .map((row) => row.address),
  );
}

/** Insert the move/win award rows for a resolved game's staked human entries,
 * returning the set of players whose points must be recomputed. Demo movers own
 * no stake entry, so they never reach here; agents/guests are filtered by the
 * player-row kind (F15 step 1). ref_id is the claim id, distinct per claim. */
function insertMoveWinAwards(
  db: Db,
  now: number,
  result: GameResult,
  stakeRows: readonly StakeEntryRow[],
  config: MoveWinConfig,
): Set<string> {
  const humans = humanPlayers(
    db,
    stakeRows.map((row) => row.player),
  );
  const touched = new Set<string>();
  for (const row of stakeRows) {
    if (!humans.has(row.player)) continue;
    const awards: { reason: "move" | "win"; amount: number }[] = [
      { reason: "move", amount: config.pointsMove },
    ];
    if (result === row.side) {
      awards.push({ reason: "win", amount: config.pointsWin });
    }
    for (const award of awards) {
      db.insert(schema.pointAwards)
        .values({
          player: row.player,
          amount: award.amount,
          reason: award.reason,
          refId: row.claimId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    touched.add(row.player);
  }
  return touched;
}

/** Award move/win points at resolution (F15 step 1). Called inside the
 * resolution transaction with the game's stake entries. */
export function awardResolutionPoints(
  db: Db,
  now: number,
  result: GameResult,
  stakeRows: readonly StakeEntryRow[],
  config: MoveWinConfig,
): void {
  const touched = insertMoveWinAwards(db, now, result, stakeRows, config);
  for (const player of touched) recomputePoints(db, player);
}

/** Credit the referrer once, the moment the referred human's staked moved-claim
 * count reaches REFERRAL_QUALIFY_MOVES (F15 step 4). Called inside the
 * MoveSettled transaction after the stake entry is written. `referral_awarded_at`
 * plus the award's UNIQUE key make it fire exactly once per referred player. */
export function maybeAwardReferral(
  db: Db,
  now: number,
  config: ReferralConfig,
  mover: string,
): boolean {
  const player = db
    .select()
    .from(schema.players)
    .where(eq(schema.players.address, mover))
    .get();
  if (
    player === undefined ||
    player.kind !== "human" ||
    player.referredBy === null ||
    player.referredBy === mover ||
    player.referralAwardedAt !== null
  )
    return false;
  const staked =
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.stakeEntries)
      .where(eq(schema.stakeEntries.player, mover))
      .get()?.count ?? 0;
  if (staked < config.referralQualifyMoves) return false;
  const referrer = db
    .select({ address: schema.players.address })
    .from(schema.players)
    .where(eq(schema.players.address, player.referredBy))
    .get();
  if (referrer === undefined) return false;

  const inserted = db
    .insert(schema.pointAwards)
    .values({
      player: referrer.address,
      amount: config.referralPoints,
      reason: "referral",
      refId: mover,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  // The flag is set regardless so retries stop; the counter/points move only on
  // a genuine insert (the UNIQUE key is the belt-and-suspenders guard).
  db.update(schema.players)
    .set({ referralAwardedAt: now })
    .where(eq(schema.players.address, mover))
    .run();
  if (inserted.changes === 0) return false;
  db.update(schema.players)
    .set({ refQualified: sql`${schema.players.refQualified} + 1` })
    .where(eq(schema.players.address, referrer.address))
    .run();
  recomputePoints(db, referrer.address);
  return true;
}

/** Deterministically backfill Release 1 history: create move/win awards for
 * every terminal game's staked human entries, then recompute the point caches
 * (F15 step 6). Idempotent — the award UNIQUE key preserves the first run's
 * immutable amounts, so repeated runs converge to identical facts and counters.
 */
export function backfillPoints(
  db: Db,
  now: number,
  config: MoveWinConfig,
): void {
  const games = db
    .select()
    .from(schema.games)
    .where(inArray(schema.games.status, ["finished", "aborted"]))
    .all();
  const touched = new Set<string>();
  for (const game of games) {
    if (game.result === null) continue;
    const stakeRows = db
      .select()
      .from(schema.stakeEntries)
      .where(eq(schema.stakeEntries.gameId, game.id))
      .all();
    for (const player of insertMoveWinAwards(
      db,
      now,
      game.result as GameResult,
      stakeRows,
      config,
    ))
      touched.add(player);
  }
  for (const player of touched) recomputePoints(db, player);
}
