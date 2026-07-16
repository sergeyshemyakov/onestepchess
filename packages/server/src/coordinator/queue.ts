import type Database from "better-sqlite3";
import PQueue from "p-queue";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import type { Logger } from "../logger.js";
import type { CoordinatorViews } from "./views.js";

export type ClaimClass = "human" | "agent" | "deprioritized";

/** Wallet humans/guests → agents → deprioritized (server spec §7); internal
 * commands (timers, settlements, pool ticks) outrank claim requests so the
 * machine's own bookkeeping is never starved by claim floods. */
const PRIORITY: Record<ClaimClass | "internal", number> = {
  internal: 100,
  human: 30,
  agent: 20,
  deprioritized: 10,
};

export type Command<P = unknown> = {
  readonly type: string;
  readonly payload: P;
  readonly refIds?: readonly string[];
  /** Present iff this is a claim command competing under §7 priority. */
  readonly claimClass?: ClaimClass;
};

export type DispatchResult<R> =
  | { readonly kind: "ok"; readonly result: R }
  | { readonly kind: "deprioritized" };

export type CommandContext = {
  /** Epoch ms captured when the command starts executing. */
  readonly now: number;
  readonly views: CoordinatorViews | null;
  appendEvent(type: string, player: string | null, payload: unknown): void;
  /** Runs after the transaction commits — view updates and notifications.
   * Never runs when the command rolls back. */
  afterCommit(hook: () => void): void;
};

/** Handlers are synchronous by contract: one command = one synchronous
 * better-sqlite3 transaction, no await points between validate and commit
 * (I8). Slow work runs outside the queue and re-enters as a command. */
export type CommandHandler<P = unknown, R = unknown> = (
  ctx: CommandContext,
  payload: P,
) => R;

export type CoordinatorOptions = {
  readonly sqlite: Database.Database;
  readonly db: Db;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly views?: CoordinatorViews;
};

export class Coordinator {
  readonly stats = { commands: 0, transactions: 0 };
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly sqlite: Database.Database;
  private readonly db: Db;
  private readonly logger: Logger;
  private readonly nowFn: () => number;
  private readonly viewsRef: CoordinatorViews | null;
  private pendingPriorityClaims = 0;

  constructor(options: CoordinatorOptions) {
    this.sqlite = options.sqlite;
    this.db = options.db;
    this.logger = options.logger;
    this.nowFn = options.now ?? Date.now;
    this.viewsRef = options.views ?? null;
  }

  register<P, R>(type: string, handler: CommandHandler<P, R>): void {
    if (this.handlers.has(type)) {
      throw new Error(`command handler already registered: ${type}`);
    }
    this.handlers.set(type, handler as CommandHandler);
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.start();
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  async dispatch<P, R = unknown>(
    command: Command<P>,
  ): Promise<DispatchResult<R>> {
    const claimClass = command.claimClass;
    if (claimClass !== undefined && claimClass !== "deprioritized") {
      this.pendingPriorityClaims += 1;
    }
    const priority = PRIORITY[claimClass ?? "internal"];
    const result = await this.queue.add(
      async () => {
      // The await point lets same-tick dispatches register before this
      // command's execution-time deprioritization check runs.
        await Promise.resolve();
        return this.execute(command);
      },
      { priority },
    );
    return result as DispatchResult<R>;
  }

  private execute<P, R>(command: Command<P>): DispatchResult<R> {
    const claimClass = command.claimClass;
    if (claimClass !== undefined && claimClass !== "deprioritized") {
      this.pendingPriorityClaims -= 1;
    }
    if (claimClass === "deprioritized" && this.pendingPriorityClaims > 0) {
      // §7: a deprioritized claim yields whenever a non-deprioritized claim
      // command is queued at execution time; the HTTP layer maps this to 204.
      return { kind: "deprioritized" };
    }

    const handler = this.handlers.get(command.type);
    if (handler === undefined) {
      throw new Error(`no handler for command: ${command.type}`);
    }

    const startedAt = performance.now();
    const now = this.nowFn();
    const afterCommitHooks: (() => void)[] = [];
    const insertEvent = this.db.insert(schema.events);
    const ctx: CommandContext = {
      now,
      views: this.viewsRef,
      appendEvent: (type, player, payload) => {
        insertEvent
          .values({ ts: now, player, type, payloadJson: JSON.stringify(payload) })
          .run();
      },
      afterCommit: (hook) => {
        afterCommitHooks.push(hook);
      },
    };

    this.stats.commands += 1;
    let result: R | undefined;
    const transaction = this.sqlite.transaction(() => {
      const value = handler(ctx, command.payload);
      if (
        value !== null &&
        typeof value === "object" &&
        "then" in (value as object)
      ) {
        throw new Error(
          `command handlers must be synchronous: ${command.type}`,
        );
      }
      result = value as R;
    });
    this.stats.transactions += 1;
    transaction.immediate();

    for (const hook of afterCommitHooks) {
      hook();
    }
    this.logger.info(
      {
        command: command.type,
        refIds: command.refIds ?? [],
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      },
      "command",
    );
    return { kind: "ok", result: result as R };
  }
}
