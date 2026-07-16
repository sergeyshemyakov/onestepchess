import { afterEach, describe, expect, it } from "vitest";
import { type OpenedDatabase, openDatabase } from "../db/open.js";
import { CoordinatorViews } from "./views.js";

const opened: OpenedDatabase[] = [];

afterEach(() => {
  for (const database of opened.splice(0)) {
    database.sqlite.close();
  }
});

const NOW = 3_600_000 * 10;
const HOUR = 3_600_000;

function seedFixture(): OpenedDatabase {
  const database = openDatabase({ path: ":memory:" });
  opened.push(database);
  const insertPlayer = database.sqlite.prepare(
    "INSERT INTO players (address, kind, created_at, banned) VALUES (?, ?, 0, ?)",
  );
  insertPlayer.run("addr-a", "human", 0);
  insertPlayer.run("addr-b", "agent", 0);
  insertPlayer.run("addr-banned", "human", 1);

  const insertGame = database.sqlite.prepare(
    `INSERT INTO games (id, name, status, fen, ply, rules_json, min_next_claim_at, last_ply_at, created_at)
     VALUES (?, ?, ?, 'fen', 4, '{"STALL_ABORT_HOURS":24}', 100, 50, 0)`,
  );
  insertGame.run("gm_active", "alpha", "active");
  insertGame.run("gm_endspiel", "beta", "endspiel");
  insertGame.run("gm_finished", "gamma", "finished");

  const insertClaim = database.sqlite.prepare(
    `INSERT INTO claims (id, game_id, player, side, demo, stake_microusdc, status, created_at, deadline)
     VALUES (?, ?, ?, 'white', ?, 1000, ?, ?, ?)`,
  );
  insertClaim.run(
    "clm_open",
    "gm_active",
    "addr-a",
    0,
    "open",
    NOW - 1000,
    NOW + 60_000,
  );
  insertClaim.run(
    "clm_recent_moved",
    "gm_endspiel",
    "addr-a",
    1,
    "moved",
    NOW - HOUR / 2,
    NOW + 60_000,
  );
  insertClaim.run(
    "clm_stale",
    "gm_finished",
    "addr-b",
    0,
    "expired",
    NOW - 2 * HOUR,
    NOW - HOUR,
  );

  database.sqlite
    .prepare("INSERT INTO revoked_jti (jti, expires_at) VALUES ('jti-1', ?)")
    .run(NOW + HOUR);
  database.sqlite
    .prepare("INSERT INTO revoked_jti (jti, expires_at) VALUES ('jti-old', ?)")
    .run(NOW - 1);
  return database;
}

describe("coordinator in-memory views", () => {
  it("rebuilds views from SQLite equal to direct SQL queries", () => {
    const database = seedFixture();
    const views = new CoordinatorViews();
    views.rebuild(database.db, NOW);

    // Non-terminal game pool ≡ SQL.
    const poolIds = database.sqlite
      .prepare(
        "SELECT id FROM games WHERE status IN ('active','endspiel') ORDER BY id",
      )
      .all()
      .map((row) => (row as { id: string }).id);
    expect([...views.games.keys()].sort()).toEqual(poolIds);
    expect(views.games.get("gm_active")?.status).toBe("active");
    expect(views.games.get("gm_active")?.rules.STALL_ABORT_HOURS).toBe(24);

    // Open claims ≡ SQL, indexed by game and player.
    const openIds = database.sqlite
      .prepare("SELECT id FROM claims WHERE status = 'open'")
      .all()
      .map((row) => (row as { id: string }).id);
    expect([...views.openClaims.keys()].sort()).toEqual(openIds.sort());
    expect(views.openClaimByGame.get("gm_active")).toBe("clm_open");
    expect(views.openClaimByPlayer.get("addr-a")).toBe("clm_open");

    // Rolling-hour quota counters count claims created in-window (demo split).
    expect(views.quota.get("addr-a")?.staked).toEqual([NOW - 1000]);
    expect(views.quota.get("addr-a")?.demo).toEqual([NOW - HOUR / 2]);
    expect(views.quota.get("addr-b")).toBeUndefined();

    // Banned set and live revoked jti set.
    expect(views.banned.has("addr-banned")).toBe(true);
    expect(views.banned.has("addr-a")).toBe(false);
    expect(views.revokedJti.has("jti-1")).toBe(true);
    expect(views.revokedJti.has("jti-old")).toBe(false);
  });

  it("rebuild replaces prior contents", () => {
    const database = seedFixture();
    const views = new CoordinatorViews();
    views.banned.add("stale-entry");
    views.games.set("gm_gone", {
      id: "gm_gone",
      name: "gone",
      status: "active",
      fen: "fen",
      ply: 0,
      minNextClaimAt: 0,
      lastPlyAt: 0,
      rules: { STALL_ABORT_HOURS: 24 } as never,
    });
    views.rebuild(database.db, NOW);
    expect(views.banned.has("stale-entry")).toBe(false);
    expect(views.games.has("gm_gone")).toBe(false);
  });
});
