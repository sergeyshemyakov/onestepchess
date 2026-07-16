import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "./open.js";

const opened: OpenedDatabase[] = [];

function open(path = ":memory:"): OpenedDatabase {
  const database = openDatabase({ path });
  opened.push(database);
  return database;
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    database.sqlite.close();
  }
});

function insertPlayer(database: OpenedDatabase, address: string): void {
  database.sqlite
    .prepare(
      "INSERT INTO players (address, kind, nickname, created_at) VALUES (?, 'human', ?, 0)",
    )
    .run(address, `nick-${address}`);
}

function insertGame(database: OpenedDatabase, id: string): void {
  database.sqlite
    .prepare(
      `INSERT INTO games (id, name, status, fen, rules_json, last_ply_at, created_at)
       VALUES (?, ?, 'active', 'fen', '{}', 0, 0)`,
    )
    .run(id, `name-${id}`);
}

function insertClaim(
  database: OpenedDatabase,
  id: string,
  gameId: string,
  player: string,
  status: "open" | "moved" | "expired" = "open",
): void {
  database.sqlite
    .prepare(
      `INSERT INTO claims (id, game_id, player, side, stake_microusdc, status, created_at, deadline)
       VALUES (?, ?, ?, 'white', 1000, ?, 0, 60000)`,
    )
    .run(id, gameId, player, status);
}

describe("drizzle schema and migrations", () => {
  it("boots on an empty DB and a second boot is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "osc-db-"));
    const path = join(dir, "osc.sqlite");
    const first = open(path);
    const tables = first.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    for (const table of [
      "players",
      "games",
      "claims",
      "stake_entries",
      "payment_intents",
      "payout_jobs",
      "payout_batches",
      "ledger",
      "ledger_balances",
      "events",
      "auth_nonces",
      "revoked_jti",
      "nickname_changes",
      "config_overrides",
      "audit_log",
      "error_log",
      "system_state",
    ]) {
      expect(tables).toContain(table);
    }
    first.sqlite.close();

    const second = open(path);
    expect(
      second.sqlite
        .prepare("SELECT count(*) AS n FROM players")
        .get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it("I1: rejects a second open claim per game at the SQL level", () => {
    const database = open();
    insertPlayer(database, "addr-a");
    insertPlayer(database, "addr-b");
    insertGame(database, "gm_1");
    insertClaim(database, "clm_1", "gm_1", "addr-a");
    expect(() =>
      insertClaim(database, "clm_2", "gm_1", "addr-b"),
    ).toThrowError(/UNIQUE/);
    // A non-open claim on the same game is fine.
    insertClaim(database, "clm_3", "gm_1", "addr-b", "moved");
  });

  it("I1: rejects a second open claim per player at the SQL level", () => {
    const database = open();
    insertPlayer(database, "addr-a");
    insertGame(database, "gm_1");
    insertGame(database, "gm_2");
    insertClaim(database, "clm_1", "gm_1", "addr-a");
    expect(() =>
      insertClaim(database, "clm_2", "gm_2", "addr-a"),
    ).toThrowError(/UNIQUE/);
    insertClaim(database, "clm_3", "gm_2", "addr-a", "expired");
  });

  it("enforces client_txid uniqueness and the per-claim in-flight lock", () => {
    const database = open();
    insertPlayer(database, "addr-a");
    insertGame(database, "gm_1");
    insertClaim(database, "clm_1", "gm_1", "addr-a");
    const insertIntent = database.sqlite.prepare(
      `INSERT INTO payment_intents (id, claim_id, player, move_uci, amount, client_txid, status, created_at, updated_at)
       VALUES (?, ?, 'addr-a', 'e2e4', 1000, ?, ?, 0, 0)`,
    );
    insertIntent.run("pi_1", "clm_1", "tx_1", "verified");
    expect(() => insertIntent.run("pi_2", "clm_1", "tx_1", "failed")).toThrow(
      /UNIQUE/,
    );
    // Same claim, different txid, but an in-flight intent already exists.
    expect(() =>
      insertIntent.run("pi_3", "clm_1", "tx_3", "settling"),
    ).toThrowError(/UNIQUE/);
    // Terminal-state intents do not hold the lock.
    insertIntent.run("pi_4", "clm_1", "tx_4", "failed");
  });

  it("system_state rejects a second row", () => {
    const database = open();
    const insert = database.sqlite.prepare(
      `INSERT INTO system_state (id, rail_kind, caip2, usdc_asset, treasury_address, pause_causes_json, updated_at)
       VALUES (?, 'mock', 'mock:local', '31566704', 'MOCK_TREASURY', '[]', 0)`,
    );
    insert.run(1);
    expect(() => insert.run(2)).toThrowError(/CHECK|constraint/i);
  });

  it("payout_jobs enforces one aggregated job per (game, recipient)", () => {
    const database = open();
    insertPlayer(database, "addr-a");
    insertGame(database, "gm_1");
    const insert = database.sqlite.prepare(
      `INSERT INTO payout_jobs (id, game_id, recipient, amount, reason, status, created_at)
       VALUES (?, 'gm_1', 'addr-a', 100, 'resolution', 'pending', 0)`,
    );
    insert.run("pj_1");
    expect(() => insert.run("pj_2")).toThrowError(/UNIQUE/);
  });

  it("activates WAL and foreign keys on the opened handle", () => {
    const dir = mkdtempSync(join(tmpdir(), "osc-db-pragma-"));
    const database = open(join(dir, "osc.sqlite"));
    expect(database.sqlite.pragma("journal_mode", { simple: true })).toBe(
      "wal",
    );
    expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      database.sqlite.pragma("busy_timeout", { simple: true }),
    ).toBeGreaterThan(0);
    // Foreign keys actually enforced, not just switched on.
    expect(() =>
      database.sqlite
        .prepare(
          `INSERT INTO claims (id, game_id, player, side, stake_microusdc, status, created_at, deadline)
           VALUES ('clm_x', 'gm_missing', 'addr-missing', 'white', 0, 'open', 0, 0)`,
        )
        .run(),
    ).toThrowError(/FOREIGN KEY/);
  });
});
