import { z } from "zod";
import { gameResultSchema } from "./schemas.js";

const sideSchema = z.enum(["white", "black"]);
const terminationSchema = z.enum([
  "checkmate",
  "stalemate",
  "insufficient",
  "threefold",
  "fifty_move",
  "max_plies",
  "aborted",
]);

const resolutionEntrySchema = z.discriminatedUnion("demo", [
  z.object({
    demo: z.literal(false),
    side: sideSchema,
    stakeMicroUsdc: z.number().int().nonnegative(),
    payoutMicroUsdc: z.number().int().nonnegative(),
    ply: z.number().int().positive(),
  }),
  z.object({
    demo: z.literal(true),
    side: sideSchema,
    stakeMicroUsdc: z.literal(0),
    payoutMicroUsdc: z.literal(0),
  }),
]);

export const sseEventSchemas = {
  claim_expiring: z.object({ claimId: z.string(), deadline: z.string() }),
  claim_expired: z.object({ claimId: z.string() }),
  move_accepted: z.object({ claimId: z.string(), txid: z.string().nullable() }),
  game_available: z.object({}),
  game_resolved: z.object({
    gameId: z.string().optional(),
    gameName: z.string().optional(),
    result: gameResultSchema,
    termination: terminationSchema,
    yourEntries: z.array(resolutionEntrySchema),
    totalPayoutMicroUsdc: z.number().int().nonnegative(),
  }),
  payout_confirmed: z.object({
    gameId: z.string(),
    txid: z.string(),
    amountMicroUsdc: z.number().int().nonnegative(),
  }),
  bonus_updated: z.object({ status: z.string() }),
  system_banner: z.object({
    mode: z.enum(["running", "paused"]),
    banner: z.string().nullable(),
  }),
  config_updated: z.object({ revision: z.number().int().nonnegative() }),
  stream_reset: z.object({ reason: z.literal("cursor_expired") }),
} as const;

export type SseEventMap = {
  readonly [Type in keyof typeof sseEventSchemas]: z.infer<
    (typeof sseEventSchemas)[Type]
  >;
};
export type SseEventType = keyof SseEventMap;
export type SseConnectionState = "connecting" | "open" | "reconnecting";

export type EventSourceLike = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
};

export type EventSourceFactory = (url: string) => EventSourceLike;
type Handler<Type extends SseEventType> = (payload: SseEventMap[Type]) => void;

/** One resumable browser EventSource with typed, validation-first fan-out. */
export class SseBus {
  readonly #source: EventSourceLike;
  readonly #handlers = new Map<SseEventType, Set<(payload: unknown) => void>>();
  readonly #stateHandlers = new Set<(state: SseConnectionState) => void>();
  readonly #listeners = new Map<string, EventListener>();
  #state: SseConnectionState = "connecting";

  constructor(factory: EventSourceFactory, url = "/api/v1/events") {
    this.#source = factory(url);
    this.#listen("open", () => this.#setState("open"));
    this.#listen("error", () => this.#setState("reconnecting"));
    for (const type of Object.keys(sseEventSchemas) as SseEventType[]) {
      this.#listen(type, (event) => this.#receive(type, event));
    }
  }

  get state(): SseConnectionState {
    return this.#state;
  }

  subscribe<Type extends SseEventType>(
    type: Type,
    handler: Handler<Type>,
  ): () => void {
    const handlers = this.#handlers.get(type) ?? new Set();
    handlers.add(handler as (payload: unknown) => void);
    this.#handlers.set(type, handlers);
    return () => handlers.delete(handler as (payload: unknown) => void);
  }

  subscribeState(handler: (state: SseConnectionState) => void): () => void {
    this.#stateHandlers.add(handler);
    handler(this.#state);
    return () => this.#stateHandlers.delete(handler);
  }

  close(): void {
    for (const [type, listener] of this.#listeners) {
      this.#source.removeEventListener(type, listener);
    }
    this.#listeners.clear();
    this.#handlers.clear();
    this.#stateHandlers.clear();
    this.#source.close();
  }

  #listen(type: string, listener: EventListener): void {
    this.#listeners.set(type, listener);
    this.#source.addEventListener(type, listener);
  }

  #setState(state: SseConnectionState): void {
    this.#state = state;
    for (const handler of this.#stateHandlers) handler(state);
  }

  #receive<Type extends SseEventType>(type: Type, event: Event): void {
    if (!(event instanceof MessageEvent)) return;
    try {
      const parsed = sseEventSchemas[type].safeParse(JSON.parse(event.data));
      if (!parsed.success) return;
      for (const handler of this.#handlers.get(type) ?? []) {
        handler(parsed.data);
      }
    } catch {
      // A malformed event is isolated; the live connection stays usable.
    }
  }
}
