import {
  GOLDEN_A,
  GOLDEN_B,
  GOLDEN_C,
  type GoldenFixture,
  gameRulesSchema,
  type Resolution,
  STARTING_FEN,
} from "@onestepchess/core";
import { eq, sql } from "drizzle-orm";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { serverConfigSchema } from "../config.js";
import {
  type Db,
  type OpenedDatabase,
  openDatabase,
  schema,
} from "../db/open.js";
import { createLogger } from "../logger.js";
import { Coordinator } from "./queue.js";
import { registerResolution } from "./resolution.js";
import { CoordinatorViews } from "./views.js";

const databases: OpenedDatabase[] = [];
const RULES = gameRulesSchema.parse(serverConfigSchema.parse({}));
const RULES_JSON = JSON.stringify(RULES);

afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

function setup(
  options: {
    resolve?: typeof import("@onestepchess/core").resolve;
    config?: Record<string, unknown>;
  } = {},
) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  let now = 5_000_000;
  const views = new CoordinatorViews();
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    now: () => now,
    views,
  });
  const config = serverConfigSchema.parse(options.config ?? {});
  registerResolution({
    coordinator,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    config: () => config,
    ...(options.resolve ? { resolve: options.resolve } : {}),
  });
  // Each setup() is a fresh in-memory DB; the player/claim seed state must
  // reset with it (fast-check calls setup() once per generated case).
  seededPlayers = new Set<string>();
  // system_state is written at boot in production; seed it so the pause path
  // has a durable row to append its cause to.
  database.db
    .insert(schema.systemState)
    .values({
      id: 1,
      railKind: "mock",
      caip2: "mock:local",
      usdcAsset: "31566704",
      treasuryAddress: "MOCK_TREASURY",
      updatedAt: now,
    })
    .run();
  return {
    db: database.db,
    coordinator,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
  };
}

type SeedEntry = {
  readonly entryId: string;
  readonly player: string;
  readonly side: "white" | "black";
  readonly kind: "human" | "agent";
  readonly amountMicroUsdc: number;
};

let seededPlayers = new Set<string>();
let claimCounter = 0;

function ensurePlayer(
  db: Db,
  address: string,
  kind: "human" | "agent" | "guest",
  now: number,
): void {
  if (seededPlayers.has(address)) return;
  db.insert(schema.players)
    .values({ address, kind, nickname: null, createdAt: now })
    .run();
  seededPlayers.add(address);
}

function seedGame(
  db: Db,
  now: number,
  args: {
    readonly gameId: string;
    readonly name: string;
    readonly status: "finished" | "aborted";
    readonly result: "white" | "black" | "draw" | "aborted";
    readonly termination: string;
    readonly entries: readonly SeedEntry[];
    readonly demoMovers?: readonly {
      readonly player: string;
      readonly kind: "human" | "guest";
      readonly side: "white" | "black";
    }[];
  },
): void {
  db.insert(schema.games)
    .values({
      id: args.gameId,
      name: args.name,
      status: args.status,
      fen: STARTING_FEN,
      rulesJson: RULES_JSON,
      lastPlyAt: now,
      createdAt: now,
      result: args.result,
      // biome-ignore lint/suspicious/noExplicitAny: test seeds a raw enum value
      termination: args.termination as any,
      finishedAt: now,
    })
    .run();
  let ply = 1;
  for (const e of args.entries) {
    ensurePlayer(db, e.player, e.kind, now);
    claimCounter += 1;
    const claimId = `clm_seed_${claimCounter}`;
    db.insert(schema.claims)
      .values({
        id: claimId,
        gameId: args.gameId,
        player: e.player,
        side: e.side,
        demo: false,
        stakeMicrousdc: e.amountMicroUsdc,
        status: "moved",
        createdAt: now,
        deadline: now + 1_000,
        movedAt: now,
        movedPly: ply,
      })
      .run();
    db.insert(schema.stakeEntries)
      .values({
        id: e.entryId,
        gameId: args.gameId,
        claimId,
        player: e.player,
        side: e.side,
        kind: e.kind,
        amount: e.amountMicroUsdc,
        payTxid: `paytx_${e.entryId}`,
        ply,
        createdAt: now,
      })
      .run();
    ply += 1;
  }
  for (const d of args.demoMovers ?? []) {
    ensurePlayer(db, d.player, d.kind, now);
    claimCounter += 1;
    const claimId = `clm_seed_${claimCounter}`;
    db.insert(schema.claims)
      .values({
        id: claimId,
        gameId: args.gameId,
        player: d.player,
        side: d.side,
        demo: true,
        stakeMicrousdc: 0,
        status: "moved",
        createdAt: now,
        deadline: now + 1_000,
        movedAt: now,
        movedPly: ply,
      })
      .run();
    ply += 1;
  }
}

afterEach(() => {
  seededPlayers = new Set<string>();
  claimCounter = 0;
});

function goldenEntries(fixture: GoldenFixture): SeedEntry[] {
  return fixture.entries.map((e) => ({
    entryId: e.entryId,
    player: e.player,
    side: e.side,
    kind: e.kind,
    amountMicroUsdc: e.amountMicroUsdc,
  }));
}

function expectedJobs(fixture: GoldenFixture): Map<string, number> {
  const byPlayer = new Map<string, number>();
  for (const c of fixture.expected.payouts) {
    byPlayer.set(c.player, (byPlayer.get(c.player) ?? 0) + c.amountMicroUsdc);
  }
  return byPlayer;
}

function expectedPayoutByEntry(fixture: GoldenFixture): Map<string, number> {
  const byEntry = new Map<string, number>();
  for (const e of fixture.entries) byEntry.set(e.entryId, 0);
  for (const c of fixture.expected.payouts) {
    byEntry.set(c.entryId, (byEntry.get(c.entryId) ?? 0) + c.amountMicroUsdc);
  }
  return byEntry;
}

async function dispatchFinish(
  stack: ReturnType<typeof setup>,
  gameId: string,
): Promise<void> {
  await stack.coordinator.dispatch({
    type: "GameFinished",
    payload: { gameId },
    refIds: [gameId],
  });
}

describe("resolution — golden fixtures (F7 step 1–2)", () => {
  for (const fixture of [GOLDEN_A, GOLDEN_B, GOLDEN_C]) {
    it(`reproduces golden ${fixture.name} end-to-end through the command`, async () => {
      const stack = setup();
      seedGame(stack.db, stack.now(), {
        gameId: "gm_golden",
        name: `golden-${fixture.name}`,
        status: "finished",
        result: fixture.result,
        termination: fixture.result === "draw" ? "stalemate" : "checkmate",
        entries: goldenEntries(fixture),
      });

      await dispatchFinish(stack, "gm_golden");

      const jobs = stack.db.select().from(schema.payoutJobs).all();
      const jobByRecipient = new Map(jobs.map((j) => [j.recipient, j.amount]));
      const expected = expectedJobs(fixture);
      for (const [player, amount] of expected) {
        if (amount === 0) continue;
        expect(jobByRecipient.get(player)).toBe(amount);
      }
      // No job for a zero-payout recipient.
      expect(jobs.every((j) => j.amount > 0)).toBe(true);

      const entriesRows = stack.db.select().from(schema.stakeEntries).all();
      const expectedByEntry = expectedPayoutByEntry(fixture);
      for (const row of entriesRows) {
        expect(row.payoutAmount).toBe(expectedByEntry.get(row.id));
      }

      const takeRows = stack.db
        .select()
        .from(schema.ledger)
        .where(sql`ref_type IN ('fee','dust','surplus')`)
        .all();
      const takeToProtocol = takeRows
        .filter((r) => r.account === "protocol")
        .reduce((sum, r) => sum + r.deltaMicrousdc, 0);
      const { feeMicroUsdc, dustMicroUsdc, surplusMicroUsdc } =
        fixture.expected.take;
      expect(takeToProtocol).toBe(
        feeMicroUsdc + dustMicroUsdc + surplusMicroUsdc,
      );

      const resolved = stack.db.select().from(schema.games).get();
      expect(resolved?.resolvedAt).toBe(stack.now());
    });
  }
});

describe("resolution — conservation runtime assert (I4)", () => {
  it("writes no jobs and pauses with a persisted cause on a violated resolution", async () => {
    // A test seam that violates conservation: pays a winner double.
    const cheating: typeof import("@onestepchess/core").resolve = (entries) => {
      const w = entries[0];
      return {
        payouts: w
          ? [
              {
                entryId: w.entryId,
                player: w.player,
                tag: "principal",
                // Over-pays the pot (30000 vs 20000 staked) — a real I4 breach.
                amountMicroUsdc: w.amountMicroUsdc * 3,
              },
            ]
          : [],
        take: { feeMicroUsdc: 0, dustMicroUsdc: 0, surplusMicroUsdc: 0 },
      } satisfies Resolution;
    };
    const stack = setup({ resolve: cheating });
    seedGame(stack.db, stack.now(), {
      gameId: "gm_bad",
      name: "bad",
      status: "finished",
      result: "white",
      termination: "checkmate",
      entries: [
        {
          entryId: "e1",
          player: "alice",
          side: "white",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
        {
          entryId: "e2",
          player: "bob",
          side: "black",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
      ],
    });

    await dispatchFinish(stack, "gm_bad");

    expect(stack.db.select().from(schema.payoutJobs).all()).toHaveLength(0);
    const game = stack.db.select().from(schema.games).get();
    expect(game?.resolvedAt).toBeNull();
    expect(stack.db.select().from(schema.errorLog).all()).toHaveLength(1);
    const state = stack.db.select().from(schema.systemState).get();
    const causes = JSON.parse(state?.pauseCausesJson ?? "[]") as string[];
    expect(causes.some((c) => c.includes("gm_bad"))).toBe(true);
    expect(
      stack.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.type, "system_banner"))
        .all(),
    ).toHaveLength(1);
  });
});

describe("resolution — aggregation (F7 step 2)", () => {
  it("emits one job per (game,recipient) and explicit zero payout for losers", async () => {
    const stack = setup();
    seedGame(stack.db, stack.now(), {
      gameId: "gm_agg",
      name: "agg",
      status: "finished",
      result: "white",
      termination: "checkmate",
      entries: [
        {
          entryId: "a1",
          player: "alice",
          side: "white",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
        {
          entryId: "a2",
          player: "alice",
          side: "white",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
        {
          entryId: "b1",
          player: "bob",
          side: "black",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
      ],
    });

    await dispatchFinish(stack, "gm_agg");

    const jobs = stack.db.select().from(schema.payoutJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.recipient).toBe("alice");
    expect(jobs[0]?.amount).toBe(30_000);
    expect(jobs[0]?.reason).toBe("resolution");

    const byEntry = new Map(
      stack.db
        .select()
        .from(schema.stakeEntries)
        .all()
        .map((r) => [r.id, r.payoutAmount]),
    );
    expect(byEntry.get("a1")).toBe(15_000);
    expect(byEntry.get("a2")).toBe(15_000);
    expect(byEntry.get("b1")).toBe(0);
  });
});

describe("resolution — idempotency (F7, I via resolved_at)", () => {
  it("is a no-op when re-run on a resolved game", async () => {
    const stack = setup();
    seedGame(stack.db, stack.now(), {
      gameId: "gm_idem",
      name: "idem",
      status: "finished",
      result: "white",
      termination: "checkmate",
      entries: [
        {
          entryId: "e1",
          player: "alice",
          side: "white",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
        {
          entryId: "e2",
          player: "bob",
          side: "black",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
      ],
    });

    await dispatchFinish(stack, "gm_idem");
    const jobsAfterFirst = stack.db.select().from(schema.payoutJobs).all();
    await dispatchFinish(stack, "gm_idem");
    const jobsAfterSecond = stack.db.select().from(schema.payoutJobs).all();
    expect(jobsAfterSecond).toHaveLength(jobsAfterFirst.length);
  });

  it("marks an all-demo game resolved with zero jobs", async () => {
    const stack = setup();
    seedGame(stack.db, stack.now(), {
      gameId: "gm_demo",
      name: "demo",
      status: "finished",
      result: "white",
      termination: "checkmate",
      entries: [],
      demoMovers: [
        { player: "carol", kind: "human", side: "white" },
        { player: "dave", kind: "human", side: "black" },
      ],
    });

    await dispatchFinish(stack, "gm_demo");

    expect(stack.db.select().from(schema.payoutJobs).all()).toHaveLength(0);
    expect(stack.db.select().from(schema.games).get()?.resolvedAt).toBe(
      stack.now(),
    );
  });
});

describe("resolution — abort path (F6/F7)", () => {
  it("refunds every entry in full and takes no fee", async () => {
    const stack = setup();
    seedGame(stack.db, stack.now(), {
      gameId: "gm_abort",
      name: "abort",
      status: "aborted",
      result: "aborted",
      termination: "aborted",
      entries: [
        {
          entryId: "e1",
          player: "alice",
          side: "white",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
        {
          entryId: "e2",
          player: "bob",
          side: "black",
          kind: "agent",
          amountMicroUsdc: 1_000,
        },
      ],
    });

    await dispatchFinish(stack, "gm_abort");

    const jobs = stack.db.select().from(schema.payoutJobs).all();
    expect(new Map(jobs.map((j) => [j.recipient, j.amount]))).toEqual(
      new Map([
        ["alice", 10_000],
        ["bob", 1_000],
      ]),
    );
    expect(jobs.every((j) => j.reason === "refund")).toBe(true);
    const take = stack.db
      .select()
      .from(schema.ledger)
      .where(sql`ref_type IN ('fee','dust','surplus')`)
      .all();
    expect(take).toHaveLength(0);
  });
});

describe("resolution — ledger running balances (I via re-sum)", () => {
  it("keeps ledger_balances equal to a full re-sum after a simulated history", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            white: fc.integer({ min: 1, max: 5 }),
            black: fc.integer({ min: 1, max: 5 }),
            result: fc.constantFrom<"white" | "black" | "draw">(
              "white",
              "black",
              "draw",
            ),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (specs) => {
          const stack = setup();
          let gi = 0;
          for (const spec of specs) {
            gi += 1;
            const entries: SeedEntry[] = [];
            for (let i = 0; i < spec.white; i += 1)
              entries.push({
                entryId: `g${gi}w${i}`,
                player: `g${gi}w${i}`,
                side: "white",
                kind: "human",
                amountMicroUsdc: 10_000,
              });
            for (let i = 0; i < spec.black; i += 1)
              entries.push({
                entryId: `g${gi}b${i}`,
                player: `g${gi}b${i}`,
                side: "black",
                kind: "agent",
                amountMicroUsdc: 1_000,
              });
            // Stakes hit the treasury book before resolution, mirroring MoveSettled.
            let treasuryDelta = 0;
            for (const e of entries) treasuryDelta += e.amountMicroUsdc;
            seedGame(stack.db, stack.now(), {
              gameId: `gm_${gi}`,
              name: `sim-${gi}`,
              status: "finished",
              result: spec.result,
              termination: spec.result === "draw" ? "stalemate" : "checkmate",
              entries,
            });
            stack.db
              .insert(schema.ledger)
              .values({
                ts: stack.now(),
                account: "treasury",
                deltaMicrousdc: treasuryDelta,
                refType: "stake",
                refId: `gm_${gi}`,
              })
              .run();
            stack.db
              .insert(schema.ledgerBalances)
              .values({ account: "treasury", balanceMicrousdc: treasuryDelta })
              .onConflictDoUpdate({
                target: schema.ledgerBalances.account,
                set: {
                  balanceMicrousdc: sql`${schema.ledgerBalances.balanceMicrousdc} + ${treasuryDelta}`,
                },
              })
              .run();
            await dispatchFinish(stack, `gm_${gi}`);
          }

          const resum = stack.db
            .select({
              account: schema.ledger.account,
              total: sql<number>`sum(${schema.ledger.deltaMicrousdc})`,
            })
            .from(schema.ledger)
            .groupBy(schema.ledger.account)
            .all();
          const balances = new Map(
            stack.db
              .select()
              .from(schema.ledgerBalances)
              .all()
              .map((r) => [r.account, r.balanceMicrousdc]),
          );
          for (const row of resum) {
            expect(balances.get(row.account)).toBe(row.total);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("resolution — game_resolved events (I7/I9, §6.4)", () => {
  it("writes staked identity payloads, a demo variant, and none for a guest", async () => {
    const stack = setup();
    seedGame(stack.db, stack.now(), {
      gameId: "gm_ev",
      name: "event-game",
      status: "finished",
      result: "white",
      termination: "checkmate",
      entries: [
        {
          entryId: "e1",
          player: "alice",
          side: "white",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
        {
          entryId: "e2",
          player: "dave",
          side: "black",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
      ],
      demoMovers: [
        { player: "carol", kind: "human", side: "white" },
        { player: "guest_zed", kind: "guest", side: "black" },
      ],
    });

    await dispatchFinish(stack, "gm_ev");

    const events = stack.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, "game_resolved"))
      .all();
    const byPlayer = new Map(
      events.map((e) => [e.player, JSON.parse(e.payloadJson)]),
    );
    // Guest gets no event (I9).
    expect(byPlayer.has("guest_zed")).toBe(false);
    expect(events).toHaveLength(3);

    const alice = byPlayer.get("alice");
    expect(alice.gameId).toBe("gm_ev");
    expect(alice.gameName).toBe("event-game");
    expect(alice.result).toBe("white");
    expect(alice.yourEntries[0]).toMatchObject({
      demo: false,
      side: "white",
      ply: expect.any(Number),
    });
    expect(alice.totalPayoutMicroUsdc).toBe(20_000);

    const carol = byPlayer.get("carol");
    expect(carol.gameId).toBeUndefined();
    expect(carol.gameName).toBeUndefined();
    expect(carol.yourEntries[0]).toEqual({
      demo: true,
      side: "white",
      stakeMicroUsdc: 0,
      payoutMicroUsdc: 0,
    });
    expect(carol.totalPayoutMicroUsdc).toBe(0);
  });
});

describe("resolution — points (F15 step 1, I11)", () => {
  it("awards move+win to staked humans and nothing to agents at resolution", async () => {
    const stack = setup();
    seedGame(stack.db, stack.now(), {
      gameId: "gm_pts",
      name: "points-game",
      status: "finished",
      result: "white",
      termination: "checkmate",
      entries: [
        {
          entryId: "e1",
          player: "human_w",
          side: "white",
          kind: "human",
          amountMicroUsdc: 10_000,
        },
        {
          entryId: "e2",
          player: "agent_b",
          side: "black",
          kind: "agent",
          amountMicroUsdc: 1_000,
        },
      ],
    });

    await dispatchFinish(stack, "gm_pts");

    const pointsOf = (address: string) =>
      stack.db
        .select({ points: schema.players.points })
        .from(schema.players)
        .where(eq(schema.players.address, address))
        .get()?.points;
    // Default knobs: POINTS_MOVE=10, POINTS_WIN=15.
    expect(pointsOf("human_w")).toBe(25);
    expect(pointsOf("agent_b")).toBe(0);
    // The award sum equals the cached counter (I11).
    const awardSum = stack.db
      .select()
      .from(schema.pointAwards)
      .all()
      .filter((a) => a.player === "human_w")
      .reduce((s, a) => s + a.amount, 0);
    expect(awardSum).toBe(25);
  });

  it("points_and_referrals_never_enter_resolution_or_payouts", async () => {
    const seedFixed = (stack: ReturnType<typeof setup>) => {
      seedGame(stack.db, stack.now(), {
        gameId: "gm_i11",
        name: "i11-game",
        status: "finished",
        result: "white",
        termination: "checkmate",
        entries: [
          {
            entryId: "e1",
            player: "alice",
            side: "white",
            kind: "human",
            amountMicroUsdc: 10_000,
          },
          {
            entryId: "e2",
            player: "bob",
            side: "black",
            kind: "human",
            amountMicroUsdc: 10_000,
          },
        ],
      });
    };
    const payoutShape = (stack: ReturnType<typeof setup>) => ({
      jobs: stack.db
        .select()
        .from(schema.payoutJobs)
        .all()
        .map((j) => `${j.recipient}:${j.amount}:${j.reason}`)
        .sort(),
      entries: stack.db
        .select()
        .from(schema.stakeEntries)
        .all()
        .map((e) => `${e.id}:${e.payoutAmount}`)
        .sort(),
      take: stack.db
        .select()
        .from(schema.ledger)
        .where(sql`ref_type IN ('fee','dust','surplus')`)
        .all()
        .reduce((s, r) => s + r.deltaMicrousdc, 0),
    });

    const base = setup();
    seedFixed(base);
    await dispatchFinish(base, "gm_i11");
    const baseShape = payoutShape(base);

    // A wildly different incentive configuration — nothing here may move a
    // single unit of the payout math (I11).
    const tweaked = setup({
      config: { POINTS_MOVE: 999, POINTS_WIN: 999, REFERRAL_POINTS: 999 },
    });
    seedFixed(tweaked);
    await dispatchFinish(tweaked, "gm_i11");

    expect(payoutShape(tweaked)).toEqual(baseShape);
    // The knob change did take effect on points, proving the inputs really
    // differed — the payout math simply ignores them.
    const alicePoints = tweaked.db
      .select({ points: schema.players.points })
      .from(schema.players)
      .where(eq(schema.players.address, "alice"))
      .get()?.points;
    expect(alicePoints).toBe(1998);
  });
});
