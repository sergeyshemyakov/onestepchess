import { createMockRail } from "@onestepchess/rail-mock";
import { describe, expect, it } from "vitest";
import { signSession } from "../../auth/jwt.js";
import { serverConfigSchema } from "../../config.js";
import { CoordinatorViews } from "../../coordinator/views.js";
import { openDatabase, schema } from "../../db/open.js";
import { PublicStats } from "../../incentives/stats.js";
import { createLogger } from "../../logger.js";
import { createApp } from "../app.js";
import { registerDiscoveryRoutes } from "./discovery.js";

function setup(
  options: { config?: Record<string, unknown>; publicStats?: PublicStats } = {},
) {
  const opened = openDatabase({ path: ":memory:" });
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl: "https://osc.example",
    mode: () => "running",
  });
  registerDiscoveryRoutes(app, {
    db: opened.db,
    config: () => serverConfigSchema.parse(options.config ?? {}),
    jwtSecret: "x".repeat(32),
    now: Date.now,
    views: new CoordinatorViews(),
    mode: () => "running",
    rail: createMockRail(),
    publicBaseUrl: "https://osc.example",
    ...(options.publicStats ? { publicStats: options.publicStats } : {}),
  });
  return { app, opened };
}

describe("discovery meta and profile (F12)", () => {
  it("serves the complete release-one meta contract without stats", async () => {
    const { app, opened } = setup();
    const response = await app.request("/api/v1/meta");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      name: "One Step Chess",
      network: { caip2: "mock:local", algodUrl: "http://localhost:4001" },
      status: { mode: "running", banner: null },
      pool: { active: 0, endspiel: 0 },
    });
    expect(body).not.toHaveProperty("stats");
    opened.sqlite.close();
  });

  it("meta_banners_reflect_the_banner_config_flags", async () => {
    const off = setup();
    const offBody = await (await off.app.request("/api/v1/meta")).json();
    expect(offBody.banners).toEqual({ tower: false, championship: false });
    off.opened.sqlite.close();

    const on = setup({
      config: { TOWER_BANNER_ENABLED: true, CHAMP_BANNER_ENABLED: true },
    });
    const onBody = await (await on.app.request("/api/v1/meta")).json();
    expect(onBody.banners).toEqual({ tower: true, championship: true });
    on.opened.sqlite.close();
  });

  it("public_stats_are_gated_and_rebuild_to_sql_ground_truth", async () => {
    // Seed a mixed history: two humans, one agent, one guest; three settled
    // staked moves (two human, one agent); two terminal games, one active.
    const opened = openDatabase({ path: ":memory:" });
    const sql = opened.sqlite;
    sql.exec(`
      INSERT INTO players(address, kind, nickname, created_at, banned) VALUES
        ('h1','human','h1',0,false),
        ('h2','human','h2',0,false),
        ('a1','agent','a1',0,false),
        ('g1','guest',NULL,0,false);
      INSERT INTO games(id,name,status,fen,rules_json,ply,last_ply_at,created_at) VALUES
        ('gm_f1','f1','finished','fen','{}',1,0,0),
        ('gm_f2','f2','aborted','fen','{}',1,0,0),
        ('gm_a','a','active','fen','{}',0,0,0);
      INSERT INTO claims(id,game_id,player,side,demo,stake_microusdc,status,created_at,deadline) VALUES
        ('c1','gm_f1','h1','white',false,1,'moved',0,1),
        ('c2','gm_f1','h2','black',false,1,'moved',0,1),
        ('c3','gm_f2','a1','white',false,1,'moved',0,1);
      INSERT INTO stake_entries(id,game_id,claim_id,player,side,kind,amount,pay_txid,ply,created_at) VALUES
        ('s1','gm_f1','c1','h1','white','human',1,'t1',1,0),
        ('s2','gm_f1','c2','h2','black','human',1,'t2',1,0),
        ('s3','gm_f2','c3','a1','white','human',1,'t3',1,0);
    `);

    const groundTruth = {
      humanMoves: 2, // h1, h2 staked moves (agent excluded)
      playersRegistered: 3, // h1, h2, a1 (guest excluded)
      gamesFinished: 2, // finished + aborted
      movesSettled: 3, // all three stake entries
    };

    // Disabled (default): /meta omits the stats block entirely.
    const disabledStats = new PublicStats();
    disabledStats.rebuild(opened.db);
    const disabled = setup({ publicStats: disabledStats });
    // Point the disabled app at the seeded DB via its own stats snapshot.
    const off = await (await disabled.app.request("/api/v1/meta")).json();
    expect(off).not.toHaveProperty("stats");
    disabled.opened.sqlite.close();

    // Enabled: /meta.stats matches SQL ground truth exactly.
    const stats = new PublicStats();
    stats.rebuild(opened.db);
    expect(stats.snapshot()).toEqual(groundTruth);
    const enabled = setup({
      config: { PUBLIC_STATS_ENABLED: true },
      publicStats: stats,
    });
    const on = (await (await enabled.app.request("/api/v1/meta")).json()) as {
      stats: unknown;
    };
    expect(on.stats).toEqual(groundTruth);
    enabled.opened.sqlite.close();

    // Restart: a fresh instance rebuilt from the same DB is byte-identical.
    const rebooted = new PublicStats();
    rebooted.rebuild(opened.db);
    expect(rebooted.snapshot()).toEqual(groundTruth);

    // Live increments keep the counters equal to a fresh rebuild.
    stats.recordPlayerRegistered();
    stats.recordStakedMoveSettled(true);
    stats.recordStakedMoveSettled(false);
    stats.recordGameFinished();
    sql.exec(`
      INSERT INTO players(address, kind, nickname, created_at, banned) VALUES ('h3','human','h3',0,false);
      INSERT INTO games(id,name,status,fen,rules_json,ply,last_ply_at,created_at) VALUES ('gm_f3','f3','finished','fen','{}',1,0,0);
      INSERT INTO claims(id,game_id,player,side,demo,stake_microusdc,status,created_at,deadline) VALUES
        ('c4','gm_f3','h3','white',false,1,'moved',0,1),
        ('c5','gm_f3','a1','black',false,1,'moved',0,1);
      INSERT INTO stake_entries(id,game_id,claim_id,player,side,kind,amount,pay_txid,ply,created_at) VALUES
        ('s4','gm_f3','c4','h3','white','human',1,'t4',1,0),
        ('s5','gm_f3','c5','a1','black','human',1,'t5',1,0);
    `);
    const afterRebuild = new PublicStats();
    afterRebuild.rebuild(opened.db);
    expect(stats.snapshot()).toEqual(afterRebuild.snapshot());
    opened.sqlite.close();
  });

  it("serves meta without changing the database", async () => {
    const { app, opened } = setup();
    const before = opened.sqlite
      .prepare("SELECT total_changes() AS n")
      .get() as { n: number };

    await app.request("/api/v1/meta");

    const after = opened.sqlite
      .prepare("SELECT total_changes() AS n")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
    opened.sqlite.close();
  });

  it("returns the minimal profile for bearer and cookie sessions", async () => {
    const { app, opened } = setup();
    const now = Date.now();
    opened.db
      .insert(schema.players)
      .values({
        address: "alice",
        kind: "human",
        nickname: "Alice",
        createdAt: now,
      })
      .run();
    const jwt = signSession("x".repeat(32), {
      sub: "alice",
      kind: "human",
      jti: "profile",
      iat: Math.floor(now / 1_000),
      exp: Math.floor(now / 1_000) + 3_600,
    });

    const bearer = await app.request("/api/v1/my/profile", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const cookie = await app.request("/api/v1/my/profile", {
      headers: { Cookie: `osc_session=${jwt}` },
    });

    const expected = {
      address: "alice",
      kind: "human",
      nickname: "Alice",
      createdAt: new Date(now).toISOString(),
    };
    expect(await bearer.json()).toEqual(expected);
    expect(await cookie.json()).toEqual(expected);
    opened.sqlite.close();
  });
});
