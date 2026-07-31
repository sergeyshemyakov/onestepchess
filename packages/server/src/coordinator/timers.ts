import { type GameRules, gameRulesSchema } from "@onestepchess/core";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

export type TimerKind =
  | "claimReveal"
  | "claimDeadline"
  | "minNextClaim"
  | "gameStall"
  | "payoutAttempt"
  | "nudge";

export type TimerServiceOptions = {
  readonly now: () => number;
  readonly onFire: (kind: TimerKind, refId: string) => void;
};

/** Durable-deadline scheduler: every deadline lives in a DB column, this
 * service only mirrors them as setTimeouts. Firing must stay idempotent —
 * the command handler re-checks the condition against the DB. */
export class TimerService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: TimerServiceOptions) {}

  private key(kind: TimerKind, refId: string): string {
    return `${kind}:${refId}`;
  }

  arm(kind: TimerKind, refId: string, dueAt: number): void {
    const key = this.key(kind, refId);
    const existing = this.timers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const delay = Math.max(0, dueAt - this.options.now());
    const handle = setTimeout(() => {
      this.timers.delete(key);
      this.options.onFire(kind, refId);
    }, delay);
    handle.unref?.();
    this.timers.set(key, handle);
  }

  disarm(kind: TimerKind, refId: string): void {
    const key = this.key(kind, refId);
    const existing = this.timers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  disarmAll(): void {
    for (const handle of this.timers.values()) {
      clearTimeout(handle);
    }
    this.timers.clear();
  }

  armed(kind: TimerKind, refId: string): boolean {
    return this.timers.has(this.key(kind, refId));
  }

  armedCount(): number {
    return this.timers.size;
  }
}

export function parseGameRules(rulesJson: string): GameRules {
  return gameRulesSchema.parse(JSON.parse(rulesJson));
}

/** Boot re-arm (F1 step 7): timers are derived from DB deadline columns; no
 * timer state survives only in memory. Overdue nudges are handled by the
 * periodic global sweep so a restart cannot fan out historic notifications. */
export function rearmTimers(
  db: Db,
  timers: TimerService,
  now: number,
  timerRevealSeconds: number,
): void {
  const openClaims = db
    .select({
      id: schema.claims.id,
      createdAt: schema.claims.createdAt,
      deadline: schema.claims.deadline,
    })
    .from(schema.claims)
    .where(eq(schema.claims.status, "open"))
    .all();
  for (const claim of openClaims) {
    timers.arm(
      "claimReveal",
      claim.id,
      Math.max(claim.createdAt, claim.deadline - timerRevealSeconds * 1_000),
    );
    timers.arm("claimDeadline", claim.id, claim.deadline);
  }

  const pendingNudges = db
    .select({
      id: schema.claims.id,
      nudgeDueAt: schema.claims.nudgeDueAt,
    })
    .from(schema.claims)
    .where(
      and(
        eq(schema.claims.status, "moved"),
        isNotNull(schema.claims.nudgeDueAt),
        isNull(schema.claims.nudgeSentAt),
      ),
    )
    .all();
  for (const claim of pendingNudges) {
    if (claim.nudgeDueAt !== null && claim.nudgeDueAt > now) {
      timers.arm("nudge", claim.id, claim.nudgeDueAt);
    }
  }

  const liveGames = db
    .select({
      id: schema.games.id,
      minNextClaimAt: schema.games.minNextClaimAt,
      lastPlyAt: schema.games.lastPlyAt,
      rulesJson: schema.games.rulesJson,
    })
    .from(schema.games)
    .where(inArray(schema.games.status, ["active", "endspiel"]))
    .all();
  for (const game of liveGames) {
    if (game.minNextClaimAt > now) {
      timers.arm("minNextClaim", game.id, game.minNextClaimAt);
    }
    const rules = parseGameRules(game.rulesJson);
    timers.arm(
      "gameStall",
      game.id,
      game.lastPlyAt + rules.STALL_ABORT_HOURS * 3_600_000,
    );
  }

  const dueJobs = db
    .select({
      id: schema.payoutJobs.id,
      nextAttemptAt: schema.payoutJobs.nextAttemptAt,
    })
    .from(schema.payoutJobs)
    .where(
      and(
        inArray(schema.payoutJobs.status, ["pending", "prepared", "submitted"]),
        isNotNull(schema.payoutJobs.nextAttemptAt),
      ),
    )
    .all();
  for (const job of dueJobs) {
    if (job.nextAttemptAt !== null) {
      timers.arm("payoutAttempt", job.id, job.nextAttemptAt);
    }
  }
}
