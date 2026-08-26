import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { CoordinatorViews } from "./coordinator/views.js";
import type { AppEnv } from "./http/app.js";

const DAY_MS = 86_400_000;

type Mode = "running" | "paused";

class RollingWindow<T> {
  private readonly entries: T[] = [];
  private head = 0;

  constructor(private readonly timestamp: (value: T) => number) {}

  add(value: T, cutoff: number): void {
    this.prune(cutoff);
    this.entries.push(value);
  }

  values(cutoff: number): readonly T[] {
    this.prune(cutoff);
    return this.entries.slice(this.head);
  }

  count(cutoff: number): number {
    this.prune(cutoff);
    return this.entries.length - this.head;
  }

  private prune(cutoff: number): void {
    while (
      this.head < this.entries.length &&
      this.timestamp(this.entries[this.head] as T) <= cutoff
    ) {
      this.head += 1;
    }
    if (this.head >= 1_024 && this.head * 2 >= this.entries.length) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }
}

export type MetricsSnapshot = {
  readonly uptimeSeconds: number;
  readonly mode: Mode;
  readonly gamesActive: number;
  readonly gamesEndspiel: number;
  readonly gamesFinished24h: number;
  readonly claimsOpen: number;
  readonly claimsCreated24h: number;
  readonly claimMoveConversionPct: number;
  readonly movesSettled24h: number;
  readonly settleLatencyP50Ms: number;
  readonly settleLatencyP95Ms: number;
  readonly facilitatorErrors24h: number;
  readonly payoutsPending: number;
  readonly payoutsSubmitted: number;
  readonly payoutsFailed: number;
  readonly sseClients: number;
  readonly quotaRejections24h: number;
  readonly authFailures24h: number;
  readonly railUnhealthySeconds24h: number;
  readonly bonusesAwaitingOptIn: number;
  readonly fundingJobsFailed: number;
  readonly fundingJobsBlocked: Record<string, number>;
};

export type FundingGaugesSnapshot = {
  readonly bonusesAwaitingOptIn: number;
  readonly fundingJobsFailed: number;
  readonly fundingJobsBlocked: Record<string, number>;
};

/** In-memory counters for `GET /api/v1/metrics` (server spec §6.3). Rolling-24h
 * windows prune on both writes and reads, so metrics remain bounded even when
 * the endpoint is disabled or not scraped. Gauges come from coordinator views;
 * the endpoint never scans database tables. */
export class Metrics {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly claimsCreated = new RollingWindow<number>((at) => at);
  private readonly movesSettled = new RollingWindow<number>((at) => at);
  private readonly gamesFinished = new RollingWindow<number>((at) => at);
  private readonly facilitatorErrors = new RollingWindow<number>((at) => at);
  private readonly quotaRejections = new RollingWindow<number>((at) => at);
  private readonly authFailures = new RollingWindow<number>((at) => at);
  private readonly settleLatencies = new RollingWindow<{
    readonly at: number;
    readonly ms: number;
  }>((entry) => entry.at);
  private readonly railUnhealthy = new RollingWindow<{
    readonly at: number;
    readonly seconds: number;
  }>((entry) => entry.at);
  private payoutsSubmitted = 0;
  private payoutsFailed = 0;
  private payoutsPending = 0;

  constructor(opts: {
    readonly now: () => number;
    readonly startedAt?: number;
  }) {
    this.now = opts.now;
    this.startedAt = opts.startedAt ?? opts.now();
  }

  recordClaimCreated(): void {
    this.record(this.claimsCreated);
  }

  recordMoveSettled(latencyMs: number): void {
    const at = this.now();
    const cutoff = at - DAY_MS;
    this.movesSettled.add(at, cutoff);
    this.settleLatencies.add({ at, ms: Math.max(0, latencyMs) }, cutoff);
  }

  recordGameFinished(): void {
    this.record(this.gamesFinished);
  }

  recordFacilitatorError(): void {
    this.record(this.facilitatorErrors);
  }

  recordQuotaRejection(): void {
    this.record(this.quotaRejections);
  }

  recordAuthFailure(): void {
    this.record(this.authFailures);
  }

  recordRailUnhealthySeconds(seconds: number): void {
    const at = this.now();
    this.railUnhealthy.add({ at, seconds: Math.max(0, seconds) }, at - DAY_MS);
  }

  recordPayoutQueued(count = 1): void {
    this.payoutsPending += count;
  }

  recordPayoutSubmitted(count = 1): void {
    this.payoutsSubmitted += count;
  }

  recordPayoutConfirmed(count = 1): void {
    this.payoutsPending = Math.max(0, this.payoutsPending - count);
  }

  recordPayoutFailed(count = 1): void {
    this.payoutsFailed += count;
    this.payoutsPending = Math.max(0, this.payoutsPending - count);
  }

  snapshot(gauges: {
    readonly mode: Mode;
    readonly gamesActive: number;
    readonly gamesEndspiel: number;
    readonly claimsOpen: number;
    readonly sseClients: number;
    readonly fundingGauges?: FundingGaugesSnapshot;
  }): MetricsSnapshot {
    const now = this.now();
    const cutoff = now - DAY_MS;
    const claimsCreated24h = this.claimsCreated.count(cutoff);
    const movesSettled24h = this.movesSettled.count(cutoff);
    const sorted = this.settleLatencies
      .values(cutoff)
      .map((entry) => entry.ms)
      .sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.min(
        sorted.length - 1,
        Math.floor((p / 100) * sorted.length),
      );
      return sorted[index] as number;
    };

    return {
      uptimeSeconds: Math.floor((now - this.startedAt) / 1_000),
      mode: gauges.mode,
      gamesActive: gauges.gamesActive,
      gamesEndspiel: gauges.gamesEndspiel,
      gamesFinished24h: this.gamesFinished.count(cutoff),
      claimsOpen: gauges.claimsOpen,
      claimsCreated24h,
      claimMoveConversionPct:
        claimsCreated24h === 0 ? 0 : (movesSettled24h / claimsCreated24h) * 100,
      movesSettled24h,
      settleLatencyP50Ms: percentile(50),
      settleLatencyP95Ms: percentile(95),
      facilitatorErrors24h: this.facilitatorErrors.count(cutoff),
      payoutsPending: this.payoutsPending,
      payoutsSubmitted: this.payoutsSubmitted,
      payoutsFailed: this.payoutsFailed,
      sseClients: gauges.sseClients,
      quotaRejections24h: this.quotaRejections.count(cutoff),
      authFailures24h: this.authFailures.count(cutoff),
      railUnhealthySeconds24h: this.railUnhealthy
        .values(cutoff)
        .reduce((sum, entry) => sum + entry.seconds, 0),
      bonusesAwaitingOptIn: gauges.fundingGauges?.bonusesAwaitingOptIn ?? 0,
      fundingJobsFailed: gauges.fundingGauges?.fundingJobsFailed ?? 0,
      fundingJobsBlocked: gauges.fundingGauges?.fundingJobsBlocked ?? {},
    };
  }

  private record(window: RollingWindow<number>): void {
    const now = this.now();
    window.add(now, now - DAY_MS);
  }
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

/** Constant-time admin-token comparison (server spec §6.5). A length mismatch
 * short-circuits (timingSafeEqual requires equal-length buffers). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type MetricsRouteDeps = {
  readonly metrics: Metrics;
  readonly views: CoordinatorViews;
  readonly clientCount: () => number;
  readonly mode: () => Mode;
  readonly adminToken: string | undefined;
  readonly fundingGauges?: () => FundingGaugesSnapshot;
};

export function registerMetricsRoute(
  app: Hono<AppEnv>,
  deps: MetricsRouteDeps,
): void {
  app.get("/api/v1/metrics", (c) => {
    const provided = bearerToken(c.req.header("authorization"));
    if (
      deps.adminToken === undefined ||
      provided === null ||
      !tokenMatches(provided, deps.adminToken)
    ) {
      // Cloak the endpoint behind the ordinary unknown-route 404.
      return c.notFound();
    }
    let gamesActive = 0;
    let gamesEndspiel = 0;
    for (const game of deps.views.games.values()) {
      if (game.status === "active") gamesActive += 1;
      else if (game.status === "endspiel") gamesEndspiel += 1;
    }
    return c.json(
      deps.metrics.snapshot({
        mode: deps.mode(),
        gamesActive,
        gamesEndspiel,
        claimsOpen: deps.views.openClaims.size,
        sseClients: deps.clientCount(),
        ...(deps.fundingGauges === undefined
          ? {}
          : { fundingGauges: deps.fundingGauges() }),
      }),
    );
  });
}
