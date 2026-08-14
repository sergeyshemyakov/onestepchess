import { afterEach, describe, expect, it } from "vitest";
import { type OpenedDatabase, openDatabase, schema } from "../db/open.js";
import { pruneSettledPaymentIntents } from "./retention.js";

const DAY = 86_400_000;
const NOW = 30 * DAY;

const opened: OpenedDatabase[] = [];

afterEach(() => {
  for (const database of opened.splice(0)) database.sqlite.close();
});

function open(): OpenedDatabase {
  const database = openDatabase({ path: ":memory:" });
  opened.push(database);
  database.sqlite
    .prepare(
      "INSERT INTO players (address, kind, created_at) VALUES ('PLAYER', 'human', 0)",
    )
    .run();
  database.sqlite
    .prepare(
      `INSERT INTO games (id, name, status, fen, rules_json, last_ply_at, created_at)
       VALUES ('g_1', 'game-1', 'finished', 'fen', '{}', 0, 0)`,
    )
    .run();
  return database;
}

function insertIntent(
  database: OpenedDatabase,
  id: string,
  status: "verified" | "settling" | "settled" | "failed",
  updatedAt: number,
): void {
  database.sqlite
    .prepare(
      `INSERT INTO claims (id, game_id, player, side, stake_microusdc, status, created_at, deadline)
       VALUES (?, 'g_1', 'PLAYER', 'white', 1000, 'moved', 0, 0)`,
    )
    .run(`c_${id}`);
  database.db
    .insert(schema.paymentIntents)
    .values({
      id: `pi_${id}`,
      claimId: `c_${id}`,
      player: "PLAYER",
      moveUci: "e2e4",
      amount: 1000,
      clientTxid: `tx_${id}`,
      status,
      paymentResponseHeader: "receipt-header",
      createdAt: updatedAt,
      updatedAt,
    })
    .run();
}

function remainingIds(database: OpenedDatabase): string[] {
  return database.db
    .select({ id: schema.paymentIntents.id })
    .from(schema.paymentIntents)
    .all()
    .map((row) => row.id)
    .sort();
}

describe("pruneSettledPaymentIntents", () => {
  it("deletes settled intents older than the retention window", () => {
    const database = open();
    insertIntent(database, "old", "settled", NOW - 8 * DAY);

    const deleted = pruneSettledPaymentIntents(database.db, NOW, 7);

    expect(deleted).toBe(1);
    expect(remainingIds(database)).toEqual([]);
  });

  it("keeps settled intents inside the retention window", () => {
    const database = open();
    insertIntent(database, "recent", "settled", NOW - 6 * DAY);

    const deleted = pruneSettledPaymentIntents(database.db, NOW, 7);

    expect(deleted).toBe(0);
    expect(remainingIds(database)).toEqual(["pi_recent"]);
  });

  // 'verified'/'settling' are money in flight and 'failed' still answers a
  // client retry with its failure code — only 'settled' is safely reproducible
  // from the claim, so age alone must never delete the other three.
  it("keeps unsettled intents regardless of age", () => {
    const database = open();
    insertIntent(database, "verified", "verified", NOW - 90 * DAY);
    insertIntent(database, "settling", "settling", NOW - 90 * DAY);
    insertIntent(database, "failed", "failed", NOW - 90 * DAY);

    const deleted = pruneSettledPaymentIntents(database.db, NOW, 7);

    expect(deleted).toBe(0);
    expect(remainingIds(database)).toEqual([
      "pi_failed",
      "pi_settling",
      "pi_verified",
    ]);
  });
});
