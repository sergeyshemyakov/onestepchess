import type Database from "better-sqlite3";
import { and, asc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { DurableEvent } from "../coordinator/queue.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import type { SessionInfo } from "../http/app.js";
import type { Logger } from "../logger.js";

const isoTimestampSchema = z.iso.datetime({ offset: true });

const stakedEntrySchema = z.object({
  demo: z.literal(false),
  side: z.enum(["white", "black"]),
  stakeMicroUsdc: z.number().int().nonnegative(),
  payoutMicroUsdc: z.number().int().nonnegative(),
  ply: z.number().int().positive(),
});

const demoEntrySchema = z.object({
  demo: z.literal(true),
  side: z.enum(["white", "black"]),
  stakeMicroUsdc: z.literal(0),
  payoutMicroUsdc: z.literal(0),
});

export const eventPayloadSchemas = {
  claim_expiring: z.object({
    claimId: z.string().min(1),
    deadline: isoTimestampSchema,
  }),
  claim_expired: z.object({ claimId: z.string().min(1) }),
  move_accepted: z.object({
    claimId: z.string().min(1),
    txid: z.string().min(1).nullable(),
  }),
  game_available: z.object({}),
  game_resolved: z
    .object({
      gameId: z.string().min(1).optional(),
      gameName: z.string().min(1).optional(),
      result: z.enum(["white", "black", "draw", "aborted"]),
      termination: z.enum([
        "checkmate",
        "stalemate",
        "insufficient",
        "threefold",
        "fifty_move",
        "max_plies",
        "aborted",
      ]),
      yourEntries: z.array(
        z.discriminatedUnion("demo", [stakedEntrySchema, demoEntrySchema]),
      ),
      totalPayoutMicroUsdc: z.number().int().nonnegative(),
    })
    .superRefine((payload, ctx) => {
      const hasStake = payload.yourEntries.some((entry) => !entry.demo);
      if (
        hasStake &&
        (payload.gameId === undefined || payload.gameName === undefined)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "staked resolution events require game identity",
        });
      }
      if (
        !hasStake &&
        (payload.gameId !== undefined || payload.gameName !== undefined)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "demo-only resolution events must omit game identity",
        });
      }
    }),
  payout_confirmed: z.object({
    gameId: z.string().min(1),
    txid: z.string().min(1),
    amountMicroUsdc: z.number().int().positive(),
  }),
  system_banner: z.object({
    mode: z.enum(["running", "paused"]),
    banner: z.string().nullable(),
  }),
  config_updated: z.object({ revision: z.number().int().nonnegative() }),
  stream_reset: z.object({ reason: z.literal("cursor_expired") }),
} as const;

export type StreamEventType = keyof typeof eventPayloadSchemas;

export type StreamSink = {
  write(chunk: string): void;
  close(): void;
};

type Connection = {
  readonly id: number;
  readonly session: SessionInfo;
  readonly sink: StreamSink;
  nextHeartbeatAt: number;
  afterId: number;
  closed: boolean;
};

export type EventStreamServiceOptions = {
  readonly sqlite: Database.Database;
  readonly db: Db;
  readonly config: () => ServerConfig;
  readonly now: () => number;
  readonly logger: Logger;
};

function formatEvent(
  id: number,
  type: StreamEventType,
  payloadJson: string,
): string {
  return `id: ${id}\nevent: ${type}\ndata: ${payloadJson}\n\n`;
}

function serializeEvent(event: DurableEvent): string | null {
  const schemaForType = eventPayloadSchemas[event.type as StreamEventType];
  if (schemaForType === undefined) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(event.payloadJson);
  } catch {
    return null;
  }
  const parsed = schemaForType.safeParse(payload);
  if (!parsed.success) return null;
  return formatEvent(
    event.id,
    event.type as StreamEventType,
    JSON.stringify(parsed.data),
  );
}

export class EventStreamService {
  private readonly connections = new Map<number, Connection>();
  private nextConnectionId = 1;

  constructor(private readonly options: EventStreamServiceOptions) {}

  get clientCount(): number {
    return this.connections.size;
  }

  connectedPlayers(): readonly string[] {
    return [
      ...new Set(
        [...this.connections.values()]
          .filter((connection) => !connection.closed)
          .map((connection) => connection.session.address),
      ),
    ];
  }

  open(args: {
    readonly session: SessionInfo;
    readonly cursor: number | null;
    readonly sink: StreamSink;
  }): () => void {
    const now = this.options.now();
    const currentId = this.currentEventId();
    const connection: Connection = {
      id: this.nextConnectionId,
      session: args.session,
      sink: args.sink,
      nextHeartbeatAt:
        now + this.options.config().SSE_HEARTBEAT_SECONDS * 1_000,
      afterId: currentId,
      closed: false,
    };
    this.nextConnectionId += 1;

    if (args.cursor !== null) {
      if (this.cursorExpired(args.cursor, currentId)) {
        args.sink.write(
          formatEvent(
            currentId,
            "stream_reset",
            JSON.stringify({ reason: "cursor_expired" }),
          ),
        );
      } else {
        const replay = this.options.db
          .select()
          .from(schema.events)
          .where(
            and(
              gt(schema.events.id, args.cursor),
              or(
                eq(schema.events.player, args.session.address),
                isNull(schema.events.player),
              ),
            ),
          )
          .orderBy(asc(schema.events.id))
          .all();
        for (const event of replay) {
          const chunk = serializeEvent(event);
          if (chunk !== null) args.sink.write(chunk);
        }
      }
    }

    this.connections.set(connection.id, connection);
    this.enforceConnectionCap(args.session.address);
    return () => this.close(connection.id);
  }

  publish(event: DurableEvent): void {
    const chunk = serializeEvent(event);
    if (chunk === null) {
      if (eventPayloadSchemas[event.type as StreamEventType] !== undefined) {
        this.options.logger.warn(
          { eventId: event.id, eventType: event.type },
          "dropping invalid SSE event payload",
        );
      }
      return;
    }
    for (const connection of this.connections.values()) {
      if (
        connection.closed ||
        event.id <= connection.afterId ||
        (event.player !== null && event.player !== connection.session.address)
      ) {
        continue;
      }
      try {
        connection.sink.write(chunk);
        connection.afterId = event.id;
      } catch {
        this.close(connection.id);
      }
    }
  }

  heartbeat(now = this.options.now()): void {
    const interval = this.options.config().SSE_HEARTBEAT_SECONDS * 1_000;
    for (const connection of [...this.connections.values()]) {
      if (connection.closed || now < connection.nextHeartbeatAt) continue;
      if (!this.sessionActive(connection.session, now)) {
        this.close(connection.id);
        continue;
      }
      try {
        connection.sink.write(": heartbeat\n\n");
        connection.nextHeartbeatAt = now + interval;
      } catch {
        this.close(connection.id);
      }
    }
  }

  prune(now = this.options.now()): number {
    const cutoff =
      now - this.options.config().EVENTS_RETENTION_DAYS * 86_400_000;
    return this.options.db
      .delete(schema.events)
      .where(lt(schema.events.ts, cutoff))
      .run().changes;
  }

  closeAll(): void {
    for (const id of [...this.connections.keys()]) this.close(id);
  }

  private currentEventId(): number {
    const row = this.options.sqlite
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  private cursorExpired(cursor: number, currentId: number): boolean {
    if (cursor >= currentId || currentId === 0) return false;
    const oldest = this.options.sqlite
      .prepare("SELECT min(id) AS id FROM events")
      .get() as { id: number | null };
    if (oldest.id === null) return true;
    if (cursor === 0) return oldest.id > 1;
    return cursor < oldest.id;
  }

  private enforceConnectionCap(address: string): void {
    const cap = this.options.config().SSE_MAX_CONNECTIONS_PER_PLAYER;
    const matching = [...this.connections.values()].filter(
      (connection) =>
        !connection.closed && connection.session.address === address,
    );
    while (matching.length > cap) {
      const oldest = matching.shift();
      if (oldest !== undefined) this.close(oldest.id);
    }
  }

  private sessionActive(session: SessionInfo, now: number): boolean {
    if (session.exp * 1_000 <= now) return false;
    const revoked = this.options.db
      .select({ jti: schema.revokedJti.jti })
      .from(schema.revokedJti)
      .where(eq(schema.revokedJti.jti, session.jti))
      .get();
    if (revoked !== undefined) return false;
    const player = this.options.db
      .select({ kind: schema.players.kind, banned: schema.players.banned })
      .from(schema.players)
      .where(eq(schema.players.address, session.address))
      .get();
    return (
      player !== undefined &&
      player.kind === session.kind &&
      player.kind !== "guest" &&
      !player.banned
    );
  }

  private close(id: number): void {
    const connection = this.connections.get(id);
    if (connection === undefined || connection.closed) return;
    connection.closed = true;
    this.connections.delete(id);
    try {
      connection.sink.close();
    } catch {
      // A canceled response may already have closed its controller.
    }
  }
}
