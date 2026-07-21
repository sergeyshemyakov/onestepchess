import { eq } from "drizzle-orm";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { type OpenedDatabase, openDatabase, schema } from "../db/open.js";
import {
  awardResolutionPoints,
  backfillPoints,
  maybeAwardReferral,
} from "./points.js";

const databases: OpenedDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

const CONFIG = {
  pointsMove: 10,
  pointsWin: 15,
  referralQualifyMoves: 3,
  referralPoints: 50,
} as const;

type Kind = "human" | "agent" | "guest";

function fresh() {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  return database.db;
}

let seq = 0;
function seedPlayer(
  db: ReturnType<typeof fresh>,
  address: string,
  kind: Kind,
  extra: Partial<typeof schema.players.$inferInsert> = {},
): void {
  db.insert(schema.players)
    .values({ address, kind, nickname: null, createdAt: 1_000, ...extra })
    .onConflictDoNothing()
    .run();
}

/** Seed one terminal game plus a moved staked claim + stake entry per entry. */
function seedGame(
  db: ReturnType<typeof fresh>,
  args: {
    gameId: string;
    result: "white" | "black" | "draw" | "aborted";
    entries: readonly {
      player: string;
      kind: Kind;
      side: "white" | "black";
      amount: number;
    }[];
    demoMovers?: readonly { player: string; kind: Kind }[];
  },
): (typeof schema.stakeEntries.$inferSelect)[] {
  db.insert(schema.games)
    .values({
      id: args.gameId,
      name: `name-${args.gameId}`,
      status: args.result === "aborted" ? "aborted" : "finished",
      fen: "fen",
      rulesJson: "{}",
      result: args.result,
      lastPlyAt: 1_000,
      createdAt: 1_000,
      finishedAt: 1_000,
    })
    .run();
  const rows: (typeof schema.stakeEntries.$inferSelect)[] = [];
  let ply = 1;
  for (const e of args.entries) {
    seedPlayer(db, e.player, e.kind);
    seq += 1;
    const claimId = `clm_${seq}`;
    db.insert(schema.claims)
      .values({
        id: claimId,
        gameId: args.gameId,
        player: e.player,
        side: e.side,
        demo: false,
        stakeMicrousdc: e.amount,
        status: "moved",
        createdAt: 1_000,
        deadline: 2_000,
        movedAt: 1_000,
        movedPly: ply,
      })
      .run();
    const entryId = `se_${seq}`;
    db.insert(schema.stakeEntries)
      .values({
        id: entryId,
        gameId: args.gameId,
        claimId,
        player: e.player,
        side: e.side,
        // stake_entries.kind is captured at stake time; points gate on the
        // player row's kind, so seed a deliberately-wrong 'human' to prove it.
        kind: "human",
        amount: e.amount,
        payTxid: `tx_${entryId}`,
        ply,
        createdAt: 1_000,
      })
      .run();
    rows.push(
      db
        .select()
        .from(schema.stakeEntries)
        .where(eq(schema.stakeEntries.id, entryId))
        .get() as typeof schema.stakeEntries.$inferSelect,
    );
    ply += 1;
  }
  for (const d of args.demoMovers ?? []) {
    seedPlayer(db, d.player, d.kind);
    seq += 1;
    db.insert(schema.claims)
      .values({
        id: `clm_${seq}`,
        gameId: args.gameId,
        player: d.player,
        side: "white",
        demo: true,
        stakeMicrousdc: 0,
        status: "moved",
        createdAt: 1_000,
        deadline: 2_000,
        movedAt: 1_000,
        movedPly: ply,
      })
      .run();
    ply += 1;
  }
  return rows;
}

function points(db: ReturnType<typeof fresh>, address: string): number {
  return (
    db
      .select({ points: schema.players.points })
      .from(schema.players)
      .where(eq(schema.players.address, address))
      .get()?.points ?? 0
  );
}

function awardsSum(db: ReturnType<typeof fresh>, address: string): number {
  return db
    .select()
    .from(schema.pointAwards)
    .where(eq(schema.pointAwards.player, address))
    .all()
    .reduce((sum, row) => sum + row.amount, 0);
}

describe("resolution points (F15 step 1)", () => {
  it("awards move+win to human winner, move-only otherwise, nothing to non-humans", () => {
    const db = fresh();
    const rows = seedGame(db, {
      gameId: "gm1",
      result: "white",
      entries: [
        { player: "human_w", kind: "human", side: "white", amount: 1000 },
        { player: "human_b", kind: "human", side: "black", amount: 1000 },
        { player: "agent_w", kind: "agent", side: "white", amount: 1000 },
      ],
      demoMovers: [{ player: "guest_d", kind: "guest" }],
    });

    awardResolutionPoints(db, 5_000, "white", rows, CONFIG);

    expect(points(db, "human_w")).toBe(CONFIG.pointsMove + CONFIG.pointsWin);
    expect(points(db, "human_b")).toBe(CONFIG.pointsMove);
    expect(points(db, "agent_w")).toBe(0);
    expect(points(db, "guest_d")).toBe(0);
    // Move award ref_id is the claim id, distinct per claim.
    const winner = db
      .select()
      .from(schema.pointAwards)
      .where(eq(schema.pointAwards.player, "human_w"))
      .all();
    expect(new Set(winner.map((a) => a.reason))).toEqual(
      new Set(["move", "win"]),
    );
  });

  it("draws and aborts earn move points only", () => {
    const db = fresh();
    const rows = seedGame(db, {
      gameId: "gm_draw",
      result: "draw",
      entries: [
        { player: "d_w", kind: "human", side: "white", amount: 500 },
        { player: "d_b", kind: "human", side: "black", amount: 500 },
      ],
    });
    awardResolutionPoints(db, 5_000, "draw", rows, CONFIG);
    expect(points(db, "d_w")).toBe(CONFIG.pointsMove);
    expect(points(db, "d_b")).toBe(CONFIG.pointsMove);
  });

  it("is idempotent — replaying resolution never double-counts", () => {
    const db = fresh();
    const rows = seedGame(db, {
      gameId: "gm_rep",
      result: "black",
      entries: [{ player: "rep", kind: "human", side: "black", amount: 1 }],
    });
    awardResolutionPoints(db, 5_000, "black", rows, CONFIG);
    awardResolutionPoints(db, 9_000, "black", rows, CONFIG);
    expect(points(db, "rep")).toBe(CONFIG.pointsMove + CONFIG.pointsWin);
    expect(db.select().from(schema.pointAwards).all().length).toBe(2);
  });
});

describe("referral award (F15 step 4)", () => {
  it("referral_award_fires_once_on_the_qualifying_staked_move", () => {
    const db = fresh();
    seedPlayer(db, "referrer", "human", { refJoined: 1 });
    seedPlayer(db, "referee", "human", { referredBy: "referrer" });
    // Below threshold: two staked moved claims, no award yet.
    seedGame(db, {
      gameId: "gm_a",
      result: "white",
      entries: [{ player: "referee", kind: "human", side: "white", amount: 1 }],
    });
    seedGame(db, {
      gameId: "gm_b",
      result: "white",
      entries: [{ player: "referee", kind: "human", side: "white", amount: 1 }],
    });
    expect(maybeAwardReferral(db, 5_000, CONFIG, "referee")).toBe(false);
    expect(points(db, "referrer")).toBe(0);

    // Third staked move reaches REFERRAL_QUALIFY_MOVES → one award.
    seedGame(db, {
      gameId: "gm_c",
      result: "white",
      entries: [{ player: "referee", kind: "human", side: "white", amount: 1 }],
    });
    expect(maybeAwardReferral(db, 6_000, CONFIG, "referee")).toBe(true);
    expect(points(db, "referrer")).toBe(CONFIG.referralPoints);
    const referrer = db
      .select()
      .from(schema.players)
      .where(eq(schema.players.address, "referrer"))
      .get();
    expect(referrer?.refQualified).toBe(1);

    // Retries and further moves never award again.
    seedGame(db, {
      gameId: "gm_d",
      result: "white",
      entries: [{ player: "referee", kind: "human", side: "white", amount: 1 }],
    });
    expect(maybeAwardReferral(db, 7_000, CONFIG, "referee")).toBe(false);
    expect(maybeAwardReferral(db, 8_000, CONFIG, "referee")).toBe(false);
    expect(points(db, "referrer")).toBe(CONFIG.referralPoints);
  });

  it("never awards a self-referral or an unset referrer", () => {
    const db = fresh();
    seedPlayer(db, "solo", "human", { referredBy: "solo" });
    seedPlayer(db, "plain", "human");
    for (const id of ["s1", "s2", "s3"]) {
      seedGame(db, {
        gameId: `gm_${id}`,
        result: "white",
        entries: [{ player: "solo", kind: "human", side: "white", amount: 1 }],
      });
    }
    expect(maybeAwardReferral(db, 5_000, CONFIG, "solo")).toBe(false);
    expect(maybeAwardReferral(db, 5_000, CONFIG, "plain")).toBe(false);
  });
});

describe("points invariant (I11)", () => {
  it("points_equal_immutable_awards_after_arbitrary_histories", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            result: fc.constantFrom(
              "white",
              "black",
              "draw",
              "aborted",
            ) as fc.Arbitrary<"white" | "black" | "draw" | "aborted">,
            entries: fc.array(
              fc.record({
                who: fc.integer({ min: 0, max: 5 }),
                kind: fc.constantFrom(
                  "human",
                  "agent",
                  "guest",
                ) as fc.Arbitrary<Kind>,
                side: fc.constantFrom("white", "black") as fc.Arbitrary<
                  "white" | "black"
                >,
                amount: fc.integer({ min: 1, max: 5000 }),
              }),
              { minLength: 1, maxLength: 4 },
            ),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (games) => {
          const db = fresh();
          const nonHuman = new Set<string>();
          const humans = new Set<string>();
          games.forEach((game, gi) => {
            // A given address keeps a stable kind across the whole history.
            const entries = game.entries.map((e) => {
              const player = `p_${e.who}`;
              const stableKind: Kind = nonHuman.has(player)
                ? ((db
                    .select({ kind: schema.players.kind })
                    .from(schema.players)
                    .where(eq(schema.players.address, player))
                    .get()?.kind as Kind) ?? e.kind)
                : e.kind;
              return {
                player,
                kind: stableKind,
                side: e.side,
                amount: e.amount,
              };
            });
            const rows = seedGame(db, {
              gameId: `gm_${gi}`,
              result: game.result,
              entries,
            });
            for (const e of entries) {
              if (e.kind === "human") humans.add(e.player);
              else nonHuman.add(e.player);
            }
            awardResolutionPoints(db, 5_000 + gi, game.result, rows, CONFIG);
          });

          // Counter equals the immutable award sum for every player.
          for (const player of db.select().from(schema.players).all()) {
            expect(player.points).toBe(awardsSum(db, player.address));
          }
          // Non-humans (agents, guests) never earn.
          for (const address of nonHuman) {
            if (humans.has(address)) continue;
            expect(points(db, address)).toBe(0);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("points backfill (F15 step 6)", () => {
  it("points_backfill_is_deterministic_and_idempotent", () => {
    const seedHistory = (db: ReturnType<typeof fresh>) => {
      seedGame(db, {
        gameId: "gm_hist_1",
        result: "white",
        entries: [
          { player: "alice", kind: "human", side: "white", amount: 1000 },
          { player: "bob", kind: "human", side: "black", amount: 1000 },
          { player: "bot", kind: "agent", side: "white", amount: 1000 },
        ],
        demoMovers: [{ player: "carol", kind: "guest" }],
      });
      seedGame(db, {
        gameId: "gm_hist_2",
        result: "draw",
        entries: [
          { player: "alice", kind: "human", side: "white", amount: 500 },
          { player: "bob", kind: "human", side: "black", amount: 500 },
        ],
      });
    };

    const snapshot = (db: ReturnType<typeof fresh>) => ({
      awards: db
        .select()
        .from(schema.pointAwards)
        .all()
        .map((a) => `${a.player}:${a.reason}:${a.refId}:${a.amount}`)
        .sort(),
      points: db
        .select()
        .from(schema.players)
        .all()
        .map((p) => `${p.address}:${p.points}`)
        .sort(),
    });

    // Both databases get byte-identical histories (same claim/game ids).
    seq = 0;
    const databaseA = openDatabase({ path: ":memory:" });
    databases.push(databaseA);
    const dbA = databaseA.db;
    seedHistory(dbA);
    backfillPoints(dbA, 42, CONFIG);
    const firstRun = snapshot(dbA);
    // Idempotent: a second pass on the same database changes nothing.
    const changesBeforeRetry = databaseA.sqlite
      .prepare("SELECT total_changes() AS n")
      .get() as { n: number };
    backfillPoints(dbA, 99, CONFIG);
    expect(snapshot(dbA)).toEqual(firstRun);
    const changesAfterRetry = databaseA.sqlite
      .prepare("SELECT total_changes() AS n")
      .get() as { n: number };
    expect(changesAfterRetry.n).toBe(changesBeforeRetry.n);

    // Deterministic: an independent database with the same history matches.
    seq = 0;
    const dbB = fresh();
    seedHistory(dbB);
    backfillPoints(dbB, 7, CONFIG);
    expect(snapshot(dbB)).toEqual(firstRun);

    // Alice: move+win (gm1) + move (gm2 draw) = 35; Bob: move (loss) + move
    // (draw) = 20; the agent and guest earn nothing.
    expect(points(dbA, "alice")).toBe(35);
    expect(points(dbA, "bob")).toBe(20);
    expect(points(dbA, "bot")).toBe(0);
    expect(points(dbA, "carol")).toBe(0);
  });

  it("rolls back award facts when a cached-counter update fails", () => {
    const database = openDatabase({ path: ":memory:" });
    databases.push(database);
    seedGame(database.db, {
      gameId: "gm_atomic_backfill",
      result: "white",
      entries: [
        { player: "alice", kind: "human", side: "white", amount: 1_000 },
      ],
    });
    database.sqlite.exec(`
      CREATE TRIGGER reject_points_update
      BEFORE UPDATE OF points ON players
      BEGIN
        SELECT RAISE(ABORT, 'counter update rejected');
      END;
    `);

    expect(() => backfillPoints(database.db, 42, CONFIG)).toThrow(
      "counter update rejected",
    );
    expect(database.db.select().from(schema.pointAwards).all()).toEqual([]);
    expect(points(database.db, "alice")).toBe(0);
  });
});
