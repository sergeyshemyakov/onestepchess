import { gameRulesSchema, STARTING_FEN } from "@onestepchess/core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { signSession } from "../auth/jwt.js";
import { serverConfigSchema } from "../config.js";
import { Coordinator } from "../coordinator/queue.js";
import { registerResolution } from "../coordinator/resolution.js";
import { CoordinatorViews } from "../coordinator/views.js";
import { type OpenedDatabase, openDatabase, schema } from "../db/open.js";
import { createApp } from "../http/app.js";
import { registerEventRoutes } from "../http/routes/events.js";
import { createLogger } from "../logger.js";
import { registerNudgeCommands } from "./nudges.js";
import { EventStreamService, type StreamSink } from "./service.js";

const JWT_SECRET = "events-test-secret-that-is-long-enough";
const BASE_URL = "https://osc.example";
const databases: OpenedDatabase[] = [];

class TestSink implements StreamSink {
  readonly chunks: string[] = [];
  closes = 0;

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  close(): void {
    this.closes += 1;
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
});

function setup(overrides: Record<string, unknown> = {}) {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  const config = serverConfigSchema.parse({
    SSE_HEARTBEAT_SECONDS: 10,
    SSE_MAX_CONNECTIONS_PER_PLAYER: 2,
    EVENTS_RETENTION_DAYS: 1,
    QUOTA_HUMAN: 1,
    QUOTA_DEMO: 2,
    QUOTA_AGENT: 5,
    ...overrides,
  });
  let now = 2 * 86_400_000;
  const logger = createLogger({ level: "silent" });
  const views = new CoordinatorViews();
  const coordinator = new Coordinator({
    sqlite: database.sqlite,
    db: database.db,
    logger,
    now: () => now,
    views,
  });
  const events = new EventStreamService({
    sqlite: database.sqlite,
    db: database.db,
    config: () => config,
    now: () => now,
    logger,
  });
  coordinator.onEvent((event) => events.publish(event));
  registerNudgeCommands({
    coordinator,
    db: database.db,
    views,
    config: () => config,
    connectedPlayers: () => events.connectedPlayers(),
  });

  const app = createApp({
    logger,
    publicBaseUrl: BASE_URL,
    mode: () => "running",
  });
  registerEventRoutes(app, {
    db: database.db,
    rail: {} as never,
    config: () => config,
    publicBaseUrl: BASE_URL,
    jwtSecret: JWT_SECRET,
    trustProxyHops: 0,
    turnstile: async () => "pass",
    now: () => now,
    rng: () => 0.5,
    coordinator,
    events,
  });
  return {
    app,
    database,
    coordinator,
    events,
    views,
    config,
    now: () => now,
    setNow(value: number) {
      now = value;
    },
  };
}

type Stack = ReturnType<typeof setup>;

function seedPlayer(
  stack: Stack,
  address: string,
  kind: "human" | "agent" | "guest" = "human",
): void {
  stack.database.db
    .insert(schema.players)
    .values({
      address,
      kind,
      nickname: kind === "guest" ? null : address,
      createdAt: 0,
    })
    .run();
}

function session(
  stack: Stack,
  address: string,
  jti = `jti-${address}`,
  kind: "human" | "agent" = "human",
) {
  return {
    address,
    kind,
    jti,
    exp: Math.floor(stack.now() / 1_000) + 3_600,
  } as const;
}

function insertEvent(
  stack: Stack,
  args: {
    readonly ts?: number;
    readonly player: string | null;
    readonly type: string;
    readonly payload: unknown;
  },
): number {
  return stack.database.db
    .insert(schema.events)
    .values({
      ts: args.ts ?? stack.now(),
      player: args.player,
      type: args.type,
      payloadJson: JSON.stringify(args.payload),
    })
    .returning({ id: schema.events.id })
    .get().id;
}

function eventFrames(
  sink: TestSink,
): { id: number; type: string; data: unknown }[] {
  return sink.chunks
    .filter((chunk) => chunk.startsWith("id:"))
    .map((chunk) => {
      const id = Number(/^id: (\d+)$/m.exec(chunk)?.[1]);
      const type = /^event: (.+)$/m.exec(chunk)?.[1] ?? "";
      const data = JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] ?? "null");
      return { id, type, data };
    });
}

function registerTestEmitter(stack: Stack): void {
  stack.coordinator.register(
    "EmitTestEvent",
    (ctx, payload: { player: string | null; type: string; data: unknown }) => {
      ctx.appendEvent(payload.type, payload.player, payload.data);
    },
  );
}

describe("resumable SSE and live human events", () => {
  it("sse_resume_replays_every_addressed_event_once", async () => {
    const stack = setup();
    seedPlayer(stack, "alice");
    seedPlayer(stack, "bob");
    insertEvent(stack, {
      player: null,
      type: "system_banner",
      payload: { mode: "running", banner: null },
    });
    insertEvent(stack, {
      player: "alice",
      type: "claim_expired",
      payload: { claimId: "clm_alice_1" },
    });
    insertEvent(stack, {
      player: "bob",
      type: "claim_expired",
      payload: { claimId: "clm_bob" },
    });
    insertEvent(stack, {
      player: "alice",
      type: "move_accepted",
      payload: { claimId: "clm_alice_2", txid: null },
    });

    const first = new TestSink();
    const closeFirst = stack.events.open({
      session: session(stack, "alice"),
      cursor: 1,
      sink: first,
    });
    expect(eventFrames(first).map((frame) => frame.id)).toEqual([2, 4]);
    closeFirst();

    registerTestEmitter(stack);
    const live = new TestSink();
    const closeLive = stack.events.open({
      session: session(stack, "alice", "jti-live"),
      cursor: 4,
      sink: live,
    });
    await stack.coordinator.dispatch({
      type: "EmitTestEvent",
      payload: {
        player: "alice",
        type: "claim_expired",
        data: { claimId: "clm_alice_3" },
      },
    });
    await stack.coordinator.dispatch({
      type: "EmitTestEvent",
      payload: {
        player: null,
        type: "config_updated",
        data: { revision: 2 },
      },
    });
    expect(eventFrames(live).map((frame) => frame.id)).toEqual([5, 6]);
    closeLive();

    const resumed = new TestSink();
    const closeResumed = stack.events.open({
      session: session(stack, "alice", "jti-resumed"),
      cursor: 4,
      sink: resumed,
    });
    expect(eventFrames(resumed).map((frame) => frame.id)).toEqual([5, 6]);
    closeResumed();

    const nowSeconds = Math.floor(stack.now() / 1_000);
    const cookieToken = signSession(JWT_SECRET, {
      sub: "alice",
      kind: "human",
      jti: "jti-cookie",
      iat: nowSeconds,
      exp: nowSeconds + 3_600,
    });
    const response = await stack.app.request("/api/v1/events?lastEventId=4", {
      headers: { cookie: `osc_session=${cookieToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("SSE response body missing");
    const decoder = new TextDecoder();
    const firstFrame = await reader.read();
    const secondFrame = await reader.read();
    expect(
      decoder.decode(firstFrame.value) + decoder.decode(secondFrame.value),
    ).toContain("id: 5\n");
    await reader.cancel();
  });

  it("sse_isolates_players_and_strips_nonterminal_identity", () => {
    const stack = setup();
    seedPlayer(stack, "alice");
    seedPlayer(stack, "bob");
    insertEvent(stack, {
      player: "alice",
      type: "move_accepted",
      payload: {
        claimId: "clm_alice",
        txid: null,
        gameId: "gm_secret",
        gameName: "secret-game",
        ply: 12,
      },
    });
    insertEvent(stack, {
      player: "bob",
      type: "claim_expiring",
      payload: {
        claimId: "clm_bob",
        deadline: new Date(stack.now() + 10_000).toISOString(),
        gameId: "gm_other",
      },
    });

    const alice = new TestSink();
    const bob = new TestSink();
    stack.events.open({
      session: session(stack, "alice"),
      cursor: 0,
      sink: alice,
    });
    stack.events.open({ session: session(stack, "bob"), cursor: 0, sink: bob });

    const aliceWire = alice.chunks.join("");
    const bobWire = bob.chunks.join("");
    expect(aliceWire).toContain("clm_alice");
    expect(aliceWire).not.toContain("clm_bob");
    expect(bobWire).toContain("clm_bob");
    expect(bobWire).not.toContain("clm_alice");
    for (const wire of [aliceWire, bobWire]) {
      expect(wire).not.toContain("gm_secret");
      expect(wire).not.toContain("gm_other");
      expect(wire).not.toContain("secret-game");
      expect(wire).not.toContain('"ply"');
    }
  });

  it("sse_expired_cursor_emits_stream_reset_before_live_events", async () => {
    const stack = setup();
    seedPlayer(stack, "alice");
    insertEvent(stack, {
      ts: 0,
      player: "alice",
      type: "claim_expired",
      payload: { claimId: "clm_pruned" },
    });
    insertEvent(stack, {
      player: "alice",
      type: "claim_expired",
      payload: { claimId: "clm_retained" },
    });
    expect(stack.events.prune()).toBe(1);

    const sink = new TestSink();
    stack.events.open({
      session: session(stack, "alice"),
      cursor: 1,
      sink,
    });
    registerTestEmitter(stack);
    await stack.coordinator.dispatch({
      type: "EmitTestEvent",
      payload: {
        player: "alice",
        type: "claim_expired",
        data: { claimId: "clm_live" },
      },
    });

    expect(eventFrames(sink)).toEqual([
      { id: 2, type: "stream_reset", data: { reason: "cursor_expired" } },
      { id: 3, type: "claim_expired", data: { claimId: "clm_live" } },
    ]);
  });

  it("sse_heartbeat_enforces_revocation_ban_and_connection_cap", () => {
    const stack = setup();
    seedPlayer(stack, "alice");
    const first = new TestSink();
    const second = new TestSink();
    const third = new TestSink();
    stack.events.open({
      session: session(stack, "alice", "jti-1"),
      cursor: null,
      sink: first,
    });
    stack.events.open({
      session: session(stack, "alice", "jti-2"),
      cursor: null,
      sink: second,
    });
    stack.events.open({
      session: session(stack, "alice", "jti-3"),
      cursor: null,
      sink: third,
    });
    expect(first.closes).toBe(1);
    expect(stack.events.clientCount).toBe(2);

    stack.events.heartbeat(stack.now() + 9_999);
    expect(second.chunks).toEqual([]);
    stack.events.heartbeat(stack.now() + 10_000);
    expect(second.chunks).toEqual([": heartbeat\n\n"]);
    expect(third.chunks).toEqual([": heartbeat\n\n"]);

    stack.database.db
      .insert(schema.revokedJti)
      .values({ jti: "jti-2", expiresAt: stack.now() + 60_000 })
      .run();
    stack.events.heartbeat(stack.now() + 20_000);
    expect(second.closes).toBe(1);
    expect(third.closes).toBe(0);

    stack.database.db
      .update(schema.players)
      .set({ banned: true })
      .where(eq(schema.players.address, "alice"))
      .run();
    stack.events.heartbeat(stack.now() + 30_000);
    expect(third.closes).toBe(1);
    expect(stack.events.clientCount).toBe(0);
  });

  it("agent_nudges_require_agent_claimability_and_never_preempt_humans", async () => {
    const stack = setup();
    const addresses = ["human-staked", "human-demo", "agent-one", "agent-two"];
    seedPlayer(stack, "human-staked");
    seedPlayer(stack, "human-demo");
    seedPlayer(stack, "agent-one", "agent");
    seedPlayer(stack, "agent-two", "agent");
    const rulesJson = JSON.stringify(gameRulesSchema.parse(stack.config));
    stack.database.db
      .insert(schema.games)
      .values({
        id: "gm_claimable",
        name: "claimable-game",
        status: "active",
        fen: STARTING_FEN,
        historyJson: "[]",
        rulesJson,
        minNextClaimAt: stack.now() + 1_000,
        lastPlyAt: stack.now(),
        createdAt: 0,
      })
      .run();
    for (const [index, address] of addresses.entries()) {
      stack.database.db
        .insert(schema.claims)
        .values({
          id: `clm_${index}`,
          gameId: "gm_claimable",
          player: address,
          side: "white",
          demo: address === "human-staked",
          stakeMicrousdc: address === "human-staked" ? 0 : 1_000,
          status: "moved",
          createdAt: stack.now() - 100,
          deadline: stack.now() - 50,
          movedAt: stack.now() - 50,
          movedPly: index + 1,
          moveUci: "e2e4",
          moveSan: "e4",
          fenAfter: STARTING_FEN,
          nudgeDueAt: stack.now() - 1,
        })
        .run();
    }
    stack.views.rebuild(stack.database.db, stack.now());
    for (const address of [
      "agent-two",
      "agent-one",
      "human-demo",
      "human-staked",
    ]) {
      stack.events.open({
        session: session(
          stack,
          address,
          `jti-${address}`,
          address.startsWith("agent") ? "agent" : "human",
        ),
        cursor: null,
        sink: new TestSink(),
      });
    }

    const skipped = await stack.coordinator.dispatch<
      Record<string, never>,
      { claimable: number; walked: number; nudged: number }
    >({ type: "NudgeTick", payload: {} });
    expect(skipped).toEqual({
      kind: "ok",
      result: { claimable: 0, walked: 0, nudged: 0 },
    });

    const view = stack.views.games.get("gm_claimable");
    if (view === undefined) throw new Error("claimable game view missing");
    view.minNextClaimAt = 0;
    const first = await stack.coordinator.dispatch<
      Record<string, never>,
      { claimable: number; walked: number; nudged: number }
    >({ type: "NudgeTick", payload: {} });
    expect(first).toEqual({
      kind: "ok",
      result: { claimable: 1, walked: 4, nudged: 3 },
    });
    const firstPlayers = stack.database.db
      .select({ player: schema.events.player })
      .from(schema.events)
      .where(eq(schema.events.type, "game_available"))
      .all()
      .map((row) => row.player);
    expect(firstPlayers).toEqual(["human-staked", "human-demo", "agent-two"]);
    expect(
      stack.database.db
        .select({ nudgeSentAt: schema.claims.nudgeSentAt })
        .from(schema.claims)
        .where(eq(schema.claims.player, "agent-one"))
        .get()?.nudgeSentAt,
    ).toBeNull();

    await stack.coordinator.dispatch({ type: "NudgeTick", payload: {} });
    await stack.coordinator.dispatch({ type: "NudgeTick", payload: {} });
    expect(
      stack.database.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.type, "game_available"))
        .all(),
    ).toHaveLength(4);

    const restartViews = new CoordinatorViews();
    restartViews.rebuild(stack.database.db, stack.now());
    const restart = new Coordinator({
      sqlite: stack.database.sqlite,
      db: stack.database.db,
      logger: createLogger({ level: "silent" }),
      now: stack.now,
      views: restartViews,
    });
    registerNudgeCommands({
      coordinator: restart,
      db: stack.database.db,
      views: restartViews,
      config: () => stack.config,
      connectedPlayers: () => addresses,
    });
    const afterRestart = await restart.dispatch<
      Record<string, never>,
      { claimable: number; walked: number; nudged: number }
    >({ type: "NudgeTick", payload: {} });
    expect(afterRestart).toMatchObject({ kind: "ok", result: { nudged: 0 } });
  });

  it("guests_cannot_open_sse_or_receive_resolution_events", async () => {
    const stack = setup();
    seedPlayer(stack, "guest_one", "guest");
    const guestToken = signSession(JWT_SECRET, {
      sub: "guest_one",
      kind: "guest",
      jti: "guest-jti",
      iat: Math.floor(stack.now() / 1_000),
      exp: Math.floor(stack.now() / 1_000) + 3_600,
    });
    const response = await stack.app.request("/api/v1/events", {
      headers: { cookie: `osc_guest=${guestToken}` },
    });
    expect(response.status).toBe(401);
    expect(stack.events.clientCount).toBe(0);

    stack.database.db
      .insert(schema.games)
      .values({
        id: "gm_guest",
        name: "guest-game",
        status: "finished",
        fen: STARTING_FEN,
        historyJson: "[]",
        rulesJson: JSON.stringify(gameRulesSchema.parse(stack.config)),
        result: "white",
        termination: "checkmate",
        minNextClaimAt: 0,
        lastPlyAt: stack.now(),
        createdAt: 0,
        finishedAt: stack.now(),
      })
      .run();
    stack.database.db
      .insert(schema.claims)
      .values({
        id: "clm_guest",
        gameId: "gm_guest",
        player: "guest_one",
        side: "white",
        demo: true,
        stakeMicrousdc: 0,
        status: "moved",
        createdAt: 0,
        deadline: 1,
        movedAt: 1,
        movedPly: 1,
        moveUci: "e2e4",
        moveSan: "e4",
        fenAfter: STARTING_FEN,
      })
      .run();
    registerResolution({
      coordinator: stack.coordinator,
      db: stack.database.db,
      logger: createLogger({ level: "silent" }),
    });
    await stack.coordinator.dispatch({
      type: "GameFinished",
      payload: { gameId: "gm_guest" },
    });
    expect(
      stack.database.db
        .select()
        .from(schema.events)
        .where(eq(schema.events.type, "game_resolved"))
        .all(),
    ).toEqual([]);
  });
});
