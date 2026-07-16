import { afterEach, describe, expect, it } from "vitest";
import { type OpenedDatabase, openDatabase } from "../db/open.js";
import { createLogger } from "../logger.js";
import { Coordinator } from "./queue.js";

const opened: OpenedDatabase[] = [];

function setup(): { database: OpenedDatabase; coordinator: Coordinator } {
  const database = openDatabase({ path: ":memory:" });
  opened.push(database);
  database.sqlite.exec(
    "CREATE TABLE test_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)",
  );
  database.sqlite.exec("INSERT INTO test_counter (id, value) VALUES (1, 0)");
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger: createLogger({ level: "silent" }),
    now: () => 42_000,
  });
  return { database, coordinator };
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    database.sqlite.close();
  }
});

function registerIncrement(
  coordinator: Coordinator,
  database: OpenedDatabase,
): void {
  coordinator.register("Increment", (ctx) => {
    const row = database.sqlite
      .prepare("SELECT value FROM test_counter WHERE id = 1")
      .get() as { value: number };
    const next = row.value + 1;
    database.sqlite
      .prepare("UPDATE test_counter SET value = ? WHERE id = 1")
      .run(next);
    ctx.appendEvent("incremented", null, { value: next });
    return next;
  });
}

describe("coordinator command queue", () => {
  it("serializes concurrently posted commands into a serial event log", async () => {
    const { database, coordinator } = setup();
    registerIncrement(coordinator, database);

    const posts = Array.from({ length: 200 }, (_, index) =>
      (async () => {
        // Interleave posting across microtask and macrotask boundaries.
        if (index % 3 === 0) await new Promise((r) => setTimeout(r, 0));
        if (index % 2 === 0) await Promise.resolve();
        return coordinator.dispatch({ type: "Increment", payload: {} });
      })(),
    );
    await Promise.all(posts);

    const values = database.sqlite
      .prepare("SELECT payload_json FROM events ORDER BY id")
      .all()
      .map(
        (row) =>
          (
            JSON.parse((row as { payload_json: string }).payload_json) as {
              value: number;
            }
          ).value,
      );
    expect(values).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it("runs exactly one transaction per command (I8)", async () => {
    const { database, coordinator } = setup();
    registerIncrement(coordinator, database);
    coordinator.register("Failing", () => {
      throw new Error("handler failure");
    });

    for (let index = 0; index < 5; index += 1) {
      await coordinator.dispatch({ type: "Increment", payload: {} });
    }
    await expect(
      coordinator.dispatch({ type: "Failing", payload: {} }),
    ).rejects.toThrowError("handler failure");

    expect(coordinator.stats.commands).toBe(6);
    expect(coordinator.stats.transactions).toBe(6);
  });

  it("rolls the whole command back when the handler throws mid-way", async () => {
    const { database, coordinator } = setup();
    coordinator.register("PartialWrite", (ctx) => {
      database.sqlite
        .prepare("UPDATE test_counter SET value = 99 WHERE id = 1")
        .run();
      ctx.appendEvent("partial", null, {});
      throw new Error("after write");
    });
    await expect(
      coordinator.dispatch({ type: "PartialWrite", payload: {} }),
    ).rejects.toThrowError("after write");
    expect(
      database.sqlite.prepare("SELECT value FROM test_counter").get(),
    ).toEqual({ value: 0 });
    expect(
      database.sqlite.prepare("SELECT count(*) AS n FROM events").get(),
    ).toEqual({ n: 0 });
  });

  it("rejects asynchronous command handlers", async () => {
    const { coordinator } = setup();
    coordinator.register("Async", async () => 1);
    await expect(
      coordinator.dispatch({ type: "Async", payload: {} }),
    ).rejects.toThrowError(/synchronous/);
  });

  it("executes a queued human claim command before a queued agent claim command", async () => {
    const { coordinator } = setup();
    const order: string[] = [];
    coordinator.register("ClaimRequested", (_ctx, payload) => {
      order.push((payload as { who: string }).who);
      return null;
    });

    coordinator.pause();
    const agent = coordinator.dispatch({
      type: "ClaimRequested",
      payload: { who: "agent" },
      claimClass: "agent",
    });
    const human = coordinator.dispatch({
      type: "ClaimRequested",
      payload: { who: "human" },
      claimClass: "human",
    });
    coordinator.resume();
    await Promise.all([agent, human]);

    expect(order).toEqual(["human", "agent"]);
  });

  it("yields a deprioritized claim command when a non-deprioritized claim is queued", async () => {
    const { coordinator } = setup();
    const order: string[] = [];
    coordinator.register("ClaimRequested", (_ctx, payload) => {
      order.push((payload as { who: string }).who);
      return null;
    });

    const deprioritized = coordinator.dispatch({
      type: "ClaimRequested",
      payload: { who: "deprioritized" },
      claimClass: "deprioritized",
    });
    const human = coordinator.dispatch({
      type: "ClaimRequested",
      payload: { who: "human" },
      claimClass: "human",
    });
    const [deprioritizedResult, humanResult] = await Promise.all([
      deprioritized,
      human,
    ]);

    expect(humanResult).toEqual({ kind: "ok", result: null });
    expect(deprioritizedResult).toEqual({ kind: "deprioritized" });
    expect(order).toEqual(["human"]);
  });

  it("executes a deprioritized claim command when nothing else waits", async () => {
    const { coordinator } = setup();
    const order: string[] = [];
    coordinator.register("ClaimRequested", (_ctx, payload) => {
      order.push((payload as { who: string }).who);
      return null;
    });
    const result = await coordinator.dispatch({
      type: "ClaimRequested",
      payload: { who: "deprioritized" },
      claimClass: "deprioritized",
    });
    expect(result).toEqual({ kind: "ok", result: null });
    expect(order).toEqual(["deprioritized"]);
  });

  it("runs afterCommit hooks only after a successful commit", async () => {
    const { database, coordinator } = setup();
    const notified: string[] = [];
    coordinator.register("Notify", (ctx) => {
      ctx.afterCommit(() => notified.push("ok"));
      return null;
    });
    coordinator.register("NotifyFail", (ctx) => {
      ctx.afterCommit(() => notified.push("bad"));
      throw new Error("no commit");
    });
    await coordinator.dispatch({ type: "Notify", payload: {} });
    await expect(
      coordinator.dispatch({ type: "NotifyFail", payload: {} }),
    ).rejects.toThrowError("no commit");
    expect(notified).toEqual(["ok"]);
    void database;
  });
});
