import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { type OpenedDatabase, openDatabase } from "./open.js";

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
      second.sqlite.prepare("SELECT count(*) AS n FROM players").get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
  });

  it("I1: rejects a second open claim per game at the SQL level", () => {
    const database = open();
    insertPlayer(database, "addr-a");
    insertPlayer(database, "addr-b");
    insertGame(database, "gm_1");
    insertClaim(database, "clm_1", "gm_1", "addr-a");
    expect(() => insertClaim(database, "clm_2", "gm_1", "addr-b")).toThrowError(
      /UNIQUE/,
    );
    // A non-open claim on the same game is fine.
    insertClaim(database, "clm_3", "gm_1", "addr-b", "moved");
  });

  it("I1: rejects a second open claim per player at the SQL level", () => {
    const database = open();
    insertPlayer(database, "addr-a");
    insertGame(database, "gm_1");
    insertGame(database, "gm_2");
    insertClaim(database, "clm_1", "gm_1", "addr-a");
    expect(() => insertClaim(database, "clm_2", "gm_2", "addr-a")).toThrowError(
      /UNIQUE/,
    );
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

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

// A database exactly as Release 1 shipped it: only migration 0000 applied,
// populated with a finished staked game and its ledger trail.
function release1Database(): string {
  const dir = mkdtempSync(join(tmpdir(), "osc-r1-"));
  const path = join(dir, "osc.sqlite");
  const migrations = join(dir, "migrations");
  mkdirSync(join(migrations, "meta"), { recursive: true });
  copyFileSync(
    join(drizzleDir, "0000_init.sql"),
    join(migrations, "0000_init.sql"),
  );
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx === 0);
  writeFileSync(
    join(migrations, "meta", "_journal.json"),
    JSON.stringify(journal),
  );
  const sqlite = new Database(path);
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite.exec(`
    INSERT INTO players (address, kind, nickname, created_at, wins, draws, losses)
      VALUES ('r1-alice', 'human', 'r1-alice', 100, 1, 0, 0),
             ('r1-bot', 'agent', 'r1-bot', 100, 0, 0, 1);
    INSERT INTO games (id, name, status, fen, history_json, rules_json, result,
                       termination, last_ply_at, created_at, finished_at, resolved_at)
      VALUES ('gm_r1', 'release-one-game', 'finished', 'final-fen', '["e2e4"]',
              '{}', 'white', 'checkmate', 200, 100, 300, 400);
    INSERT INTO claims (id, game_id, player, side, demo, stake_microusdc, status,
                        created_at, deadline, moved_at, moved_ply, move_uci, move_san, fen_after)
      VALUES ('clm_r1', 'gm_r1', 'r1-alice', 'white', 0, 1000, 'moved',
              100, 700, 200, 1, 'e2e4', 'e4', 'final-fen');
    INSERT INTO stake_entries (id, game_id, claim_id, player, side, kind, amount,
                               pay_txid, ply, payout_amount, created_at)
      VALUES ('se_r1', 'gm_r1', 'clm_r1', 'r1-alice', 'white', 'human', 1000,
              'ptx_r1', 1, 2000, 200);
    INSERT INTO ledger (ts, account, delta_microusdc, ref_type, ref_id, txid)
      VALUES (200, 'treasury', 1000, 'stake', 'clm_r1', 'ptx_r1');
    INSERT INTO ledger_balances (account, balance_microusdc)
      VALUES ('treasury', 1000);
  `);
  sqlite.close();
  return path;
}

function dumpTables(
  sqlite: Database.Database,
  tables: readonly string[],
): Record<string, unknown[]> {
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    dump[table] = sqlite.prepare(`SELECT * FROM ${table}`).all();
  }
  return dump;
}

const RELEASE1_TABLES = [
  "players",
  "games",
  "claims",
  "stake_entries",
  "ledger",
  "ledger_balances",
] as const;

describe("release-2 migration (0001_release2_human_reads)", () => {
  it("release1_database_migrates_to_guest_link_schema", () => {
    const path = release1Database();
    const before = new Database(path, { readonly: true });
    const snapshot = dumpTables(before, RELEASE1_TABLES);
    before.close();

    const database = open(path);
    const columns = database.sqlite
      .prepare("PRAGMA table_info(players)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain("linked_address");
    expect(columns).toContain("linked_at");

    // Existing rows survive unchanged; the new columns backfill as NULL.
    const after = dumpTables(database.sqlite, RELEASE1_TABLES);
    for (const table of RELEASE1_TABLES) {
      if (table === "players") continue;
      expect(after[table]).toEqual(snapshot[table]);
    }
    expect(
      after.players?.map((row) => {
        const {
          linked_address,
          linked_at,
          ref_code,
          referred_by,
          referral_awarded_at,
          ref_joined,
          ref_qualified,
          points,
          ...rest
        } = row as Record<string, unknown>;
        expect(linked_address).toBeNull();
        expect(linked_at).toBeNull();
        // Incentive columns (0002) backfill as NULL / 0 on existing rows.
        expect(ref_code).toBeNull();
        expect(referred_by).toBeNull();
        expect(referral_awarded_at).toBeNull();
        expect(ref_joined).toBe(0);
        expect(ref_qualified).toBe(0);
        expect(points).toBe(0);
        return rest;
      }),
    ).toEqual(snapshot.players);

    // The guest-link write path works on the migrated schema.
    database.sqlite
      .prepare(
        `INSERT INTO players (address, kind, nickname, created_at, turnstile_verified_at, linked_address, linked_at)
         VALUES ('guest_r2', 'guest', NULL, 500, 500, 'r1-alice', 600)`,
      )
      .run();
    expect(
      database.sqlite
        .prepare("SELECT linked_address FROM players WHERE address = ?")
        .get("guest_r2"),
    ).toEqual({ linked_address: "r1-alice" });
  });

  it("release1_database_migrates_to_human_read_models", () => {
    // An empty database reaches the same schema.
    const emptyDir = mkdtempSync(join(tmpdir(), "osc-r2-empty-"));
    const empty = open(join(emptyDir, "osc.sqlite"));
    const emptyIndexes = empty.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const index of [
      "claims_player_status_moved_at",
      "games_status_finished_at",
      "nickname_changes_player_changed_at",
    ]) {
      expect(emptyIndexes).toContain(index);
    }

    const path = release1Database();
    const database = open(path);
    const indexes = database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toContain("claims_player_status_moved_at");
    expect(indexes).toContain("games_status_finished_at");

    // Finished-game history stays readable through the read-model query shape.
    const finished = database.sqlite
      .prepare(
        `SELECT c.id, g.name, g.result, g.termination, c.move_san, s.payout_amount
         FROM claims c
         JOIN games g ON g.id = c.game_id
         JOIN stake_entries s ON s.claim_id = c.id
         WHERE c.player = ? AND c.status = 'moved' AND g.status = 'finished'
         ORDER BY g.finished_at DESC`,
      )
      .all("r1-alice");
    expect(finished).toEqual([
      {
        id: "clm_r1",
        name: "release-one-game",
        result: "white",
        termination: "checkmate",
        move_san: "e4",
        payout_amount: 2000,
      },
    ]);

    // The rename limiter's durable log accepts rows on the migrated schema.
    database.sqlite
      .prepare(
        "INSERT INTO nickname_changes (player, changed_at) VALUES ('r1-alice', 700)",
      )
      .run();
    expect(
      database.sqlite
        .prepare("SELECT count(*) AS n FROM nickname_changes")
        .get(),
    ).toEqual({ n: 1 });
  });
});
