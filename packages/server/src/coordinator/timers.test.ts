import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OpenedDatabase, openDatabase } from "../db/open.js";
import { createLogger } from "../logger.js";
import { Coordinator } from "./queue.js";
import { rearmTimers, TimerService } from "./timers.js";

const opened: OpenedDatabase[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  for (const database of opened.splice(0)) {
    database.sqlite.close();
  }
});

function setup() {
  const database = openDatabase({ path: ":memory:" });
  opened.push(database);
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    now: () => Date.now(),
  });
  const timers = new TimerService({
    now: () => Date.now(),
    onFire: (kind, refId) => {
      void coordinator.dispatch({
        type: "TimerFired",
        payload: { kind, refId },
        refIds: [refId],
      });
    },
  });
  return { database, coordinator, timers };
}

function seedOpenClaim(database: OpenedDatabase, deadline: number): void {
  database.sqlite
    .prepare(
      "INSERT INTO players (address, kind, created_at) VALUES ('addr-a', 'human', 0)",
    )
    .run();
  database.sqlite
    .prepare(
      `INSERT INTO games (id, name, status, fen, rules_json, last_ply_at, created_at)
       VALUES ('gm_1', 'game-one', 'active', 'fen', '{"STALL_ABORT_HOURS":24}', 0, 0)`,
    )
    .run();
  database.sqlite
    .prepare(
      `INSERT INTO claims (id, game_id, player, side, stake_microusdc, status, created_at, deadline)
       VALUES ('clm_1', 'gm_1', 'addr-a', 'white', 1000, 'open', 0, ?)`,
    )
    .run(deadline);
}

/** Registers the idempotent expiry condition the way a real timer handler
 * must: re-check the DB before acting, act inside the command transaction. */
function registerExpiry(
  coordinator: Coordinator,
  database: OpenedDatabase,
): void {
  coordinator.register("TimerFired", (ctx, payload) => {
    const { kind, refId } = payload as { kind: string; refId: string };
    if (kind !== "claimDeadline") return null;
    const claim = database.sqlite
      .prepare("SELECT status, deadline FROM claims WHERE id = ?")
      .get(refId) as { status: string; deadline: number } | undefined;
    if (claim?.status !== "open" || ctx.now < claim.deadline) {
      return null;
    }
    database.sqlite
      .prepare("UPDATE claims SET status = 'expired' WHERE id = ?")
      .run(refId);
    ctx.appendEvent("claim_expired", "addr-a", { claimId: refId });
    return null;
  });
}

describe("timer service", () => {
  it("acts once when a timer double-fires", async () => {
    const { database, coordinator, timers } = setup();
    seedOpenClaim(database, 10_000);
    registerExpiry(coordinator, database);

    timers.arm("claimDeadline", "clm_1", 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    // Simulate a stale duplicate firing of the same timer.
    await coordinator.dispatch({
      type: "TimerFired",
      payload: { kind: "claimDeadline", refId: "clm_1" },
    });

    const events = database.sqlite
      .prepare("SELECT count(*) AS n FROM events WHERE type = 'claim_expired'")
      .get() as { n: number };
    expect(events.n).toBe(1);
    expect(
      database.sqlite
        .prepare("SELECT status FROM claims WHERE id = 'clm_1'")
        .get(),
    ).toEqual({ status: "expired" });
  });

  it("re-arming the same timer replaces the earlier deadline", async () => {
    const { database, coordinator, timers } = setup();
    seedOpenClaim(database, 20_000);
    registerExpiry(coordinator, database);

    timers.arm("claimDeadline", "clm_1", 10_000);
    timers.arm("claimDeadline", "clm_1", 20_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      database.sqlite
        .prepare("SELECT status FROM claims WHERE id = 'clm_1'")
        .get(),
    ).toEqual({ status: "open" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      database.sqlite
        .prepare("SELECT status FROM claims WHERE id = 'clm_1'")
        .get(),
    ).toEqual({ status: "expired" });
  });

  it("fires timers after a simulated restart via re-arm from DB columns", async () => {
    const { database } = setup();
    seedOpenClaim(database, 30_000);

    // "Restart": a fresh coordinator + timer service re-arm purely from DB.
    const coordinator = new Coordinator({
      sqlite: database.sqlite,
      db: database.db,
      logger: createLogger({ level: "silent" }),
      now: () => Date.now(),
    });
    const timers = new TimerService({
      now: () => Date.now(),
      onFire: (kind, refId) => {
        void coordinator.dispatch({
          type: "TimerFired",
          payload: { kind, refId },
          refIds: [refId],
        });
      },
    });
    registerExpiry(coordinator, database);
    rearmTimers(database.db, timers, Date.now(), 120);

    expect(timers.armedCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await coordinator.onIdle();
    expect(
      database.sqlite
        .prepare("SELECT status FROM claims WHERE id = 'clm_1'")
        .get(),
    ).toEqual({ status: "expired" });
  });

  it("re-arms every timer kind from its DB column", () => {
    const { database, timers } = setup();
    seedOpenClaim(database, 30_000);
    database.sqlite
      .prepare(
        "UPDATE games SET min_next_claim_at = 40000, last_ply_at = 1000 WHERE id = 'gm_1'",
      )
      .run();
    database.sqlite
      .prepare(
        `INSERT INTO payout_jobs (id, game_id, recipient, amount, reason, status, next_attempt_at, created_at)
         VALUES ('pj_1', 'gm_1', 'addr-a', 5, 'refund', 'pending', 50000, 0)`,
      )
      .run();
    database.sqlite
      .prepare(
        `INSERT INTO claims (id, game_id, player, side, stake_microusdc, status, created_at, deadline, moved_at, nudge_due_at)
         VALUES ('clm_2', 'gm_1', 'addr-a', 'white', 1000, 'moved', 0, 1000, 1000, 60000)`,
      )
      .run();

    rearmTimers(database.db, timers, Date.now(), 120);

    expect(timers.armed("claimReveal", "clm_1")).toBe(true);
    expect(timers.armed("claimDeadline", "clm_1")).toBe(true);
    expect(timers.armed("minNextClaim", "gm_1")).toBe(true);
    expect(timers.armed("gameStall", "gm_1")).toBe(true);
    expect(timers.armed("payoutAttempt", "pj_1")).toBe(true);
    expect(timers.armed("nudge", "clm_2")).toBe(true);
  });

  it("skips nudges already due when restoring timers at boot", () => {
    const { database, timers } = setup();
    seedOpenClaim(database, 30_000);
    database.sqlite
      .prepare(
        `INSERT INTO claims (id, game_id, player, side, stake_microusdc, status, created_at, deadline, moved_at, nudge_due_at)
         VALUES ('clm_due', 'gm_1', 'addr-a', 'white', 1000, 'moved', 0, 1000, 1000, 10000),
                ('clm_future', 'gm_1', 'addr-a', 'black', 1000, 'moved', 0, 1000, 1000, 20000)`,
      )
      .run();

    vi.setSystemTime(15_000);
    rearmTimers(database.db, timers, Date.now(), 120);

    expect(timers.armed("nudge", "clm_due")).toBe(false);
    expect(timers.armed("nudge", "clm_future")).toBe(true);
  });
});
