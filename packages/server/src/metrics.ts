import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { CoordinatorViews } from "./coordinator/views.js";
import type { AppEnv } from "./http/app.js";

const DAY_MS = 86_400_000;

type Mode = "running" | "paused";

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
};

/** In-memory counters for `GET /api/v1/metrics` (server spec §6.3). Rolling-24h
 * figures are kept as append-only timestamp lists pruned on read; gauges are
 * read from the coordinator's views at snapshot time. Nothing here touches the
 * database — the endpoint must never scan tables.
 *
 * Wired now: claim/move/quota/auth counters (HTTP edge) and the live gauges.
 * The game-finished, facilitator, and payout counters are part of the starter
 * shape but fed by the Release 3 operations surface (a non-goal for this card),
 * so their record methods exist without a production caller yet. */
export class Metrics {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly claimsCreated: number[] = [];
  private readonly movesSettled: number[] = [];
  private readonly gamesFinished: number[] = [];
  private readonly facilitatorErrors: number[] = [];
  private readonly quotaRejections: number[] = [];
  private readonly authFailures: number[] = [];
  private readonly settleLatencies: Array<{ at: number; ms: number }> = [];
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
    this.claimsCreated.push(this.now());
  }

  recordMoveSettled(latencyMs: number): void {
    const at = this.now();
    this.movesSettled.push(at);
    this.settleLatencies.push({ at, ms: Math.max(0, latencyMs) });
  }

  recordGameFinished(): void {
    this.gamesFinished.push(this.now());
  }

  recordFacilitatorError(): void {
    this.facilitatorErrors.push(this.now());
  }

  recordQuotaRejection(): void {
    this.quotaRejections.push(this.now());
  }

  recordAuthFailure(): void {
    this.authFailures.push(this.now());
  }

  recordPayoutSubmitted(): void {
    this.payoutsSubmitted += 1;
    this.payoutsPending += 1;
  }

  recordPayoutConfirmed(): void {
    this.payoutsPending = Math.max(0, this.payoutsPending - 1);
  }

  recordPayoutFailed(): void {
    this.payoutsFailed += 1;
    this.payoutsPending = Math.max(0, this.payoutsPending - 1);
  }

  snapshot(gauges: {
    readonly mode: Mode;
    readonly gamesActive: number;
    readonly gamesEndspiel: number;
    readonly claimsOpen: number;
    readonly sseClients: number;
  }): MetricsSnapshot {
    const now = this.now();
    const cutoff = now - DAY_MS;
    const count = (list: number[]): number => {
      while (list.length > 0 && (list[0] as number) <= cutoff) list.shift();
      return list.length;
    };
    while (
      this.settleLatencies.length > 0 &&
      (this.settleLatencies[0] as { at: number }).at <= cutoff
    )
      this.settleLatencies.shift();

    const claimsCreated24h = count(this.claimsCreated);
    const movesSettled24h = count(this.movesSettled);
    const sorted = this.settleLatencies
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
      gamesFinished24h: count(this.gamesFinished),
      claimsOpen: gauges.claimsOpen,
      claimsCreated24h,
      claimMoveConversionPct:
        claimsCreated24h === 0 ? 0 : (movesSettled24h / claimsCreated24h) * 100,
      movesSettled24h,
      settleLatencyP50Ms: percentile(50),
      settleLatencyP95Ms: percentile(95),
      facilitatorErrors24h: count(this.facilitatorErrors),
      payoutsPending: this.payoutsPending,
      payoutsSubmitted: this.payoutsSubmitted,
      payoutsFailed: this.payoutsFailed,
      sseClients: gauges.sseClients,
      quotaRejections24h: count(this.quotaRejections),
      authFailures24h: count(this.authFailures),
    };
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
      }),
    );
  });
}
