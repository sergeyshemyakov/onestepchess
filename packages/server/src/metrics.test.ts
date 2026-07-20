import type { GameRules } from "@onestepchess/core";
import { describe, expect, it } from "vitest";
import { CoordinatorViews } from "./coordinator/views.js";
import { createApp } from "./http/app.js";
import { createLogger } from "./logger.js";
import { Metrics, registerMetricsRoute } from "./metrics.js";

const STARTER_KEYS = [
  "uptimeSeconds",
  "mode",
  "gamesActive",
  "gamesEndspiel",
  "gamesFinished24h",
  "claimsOpen",
  "claimsCreated24h",
  "claimMoveConversionPct",
  "movesSettled24h",
  "settleLatencyP50Ms",
  "settleLatencyP95Ms",
  "facilitatorErrors24h",
  "payoutsPending",
  "payoutsSubmitted",
  "payoutsFailed",
  "sseClients",
  "quotaRejections24h",
  "authFailures24h",
];

function gameView(id: string, status: "active" | "endspiel") {
  return {
    id,
    name: id,
    status,
    fen: "startpos",
    ply: 1,
    minNextClaimAt: 0,
    lastPlyAt: 0,
    rules: {} as GameRules,
  };
}

function setup(adminToken?: string) {
  let now = 1_000_000;
  let clients = 0;
  const metrics = new Metrics({ now: () => now, startedAt: now - 5_000 });
  const views = new CoordinatorViews();
  // No `db` is threaded into the metrics route: the endpoint reads only
  // in-memory views/counters, which structurally forbids table scans (§6.3).
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    publicBaseUrl: "https://osc.example",
    mode: () => "running",
  });
  registerMetricsRoute(app, {
    metrics,
    views,
    clientCount: () => clients,
    mode: () => "running",
    adminToken,
  });
  return {
    app,
    metrics,
    views,
    setClients: (n: number) => {
      clients = n;
    },
    setNow: (v: number) => {
      now = v;
    },
  };
}

describe("/api/v1/metrics (§6.3)", () => {
  it("metrics_are_incremental_secret_free_and_admin_token_gated", async () => {
    const token = "super-secret-admin-token-value";
    const ctx = setup(token);
    ctx.views.games.set("g1", gameView("g1", "active"));
    ctx.views.games.set("g2", gameView("g2", "endspiel"));
    ctx.setClients(3);

    // Admin-token gated: missing or wrong token is cloaked as an unknown route.
    expect((await ctx.app.request("/api/v1/metrics")).status).toBe(404);
    expect(
      (
        await ctx.app.request("/api/v1/metrics", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(404);

    const authed = { Authorization: `Bearer ${token}` };
    const before = await (
      await ctx.app.request("/api/v1/metrics", { headers: authed })
    ).json();
    expect(before.gamesActive).toBe(1);
    expect(before.gamesEndspiel).toBe(1);
    expect(before.sseClients).toBe(3);
    expect(before.claimsCreated24h).toBe(0);
    expect(before.uptimeSeconds).toBe(5);

    // Counters change incrementally as activity is recorded.
    ctx.metrics.recordClaimCreated();
    ctx.metrics.recordClaimCreated();
    ctx.metrics.recordMoveSettled(1_200);
    ctx.metrics.recordGameFinished();
    ctx.metrics.recordFacilitatorError();
    ctx.metrics.recordPayoutQueued(2);
    ctx.metrics.recordPayoutSubmitted(2);
    ctx.metrics.recordPayoutConfirmed();
    ctx.metrics.recordPayoutFailed();

    const after = await (
      await ctx.app.request("/api/v1/metrics", { headers: authed })
    ).json();
    expect(after.claimsCreated24h).toBe(2);
    expect(after.movesSettled24h).toBe(1);
    expect(after.settleLatencyP95Ms).toBe(1_200);
    expect(after.claimMoveConversionPct).toBeCloseTo(50);
    expect(after.gamesFinished24h).toBe(1);
    expect(after.facilitatorErrors24h).toBe(1);
    expect(after.payoutsPending).toBe(0);
    expect(after.payoutsSubmitted).toBe(2);
    expect(after.payoutsFailed).toBe(1);

    // Redaction: the response never echoes the admin token or other secrets.
    const raw = await (
      await ctx.app.request("/api/v1/metrics", { headers: authed })
    ).text();
    expect(raw).not.toContain(token);
    const snap = JSON.parse(raw);
    for (const key of STARTER_KEYS) expect(snap).toHaveProperty(key);
  });

  it("drops counters outside the rolling 24h window", async () => {
    const ctx = setup("t");
    ctx.metrics.recordClaimCreated();
    ctx.setNow(1_000_000 + 25 * 3_600_000);
    const snap = ctx.metrics.snapshot({
      mode: "running",
      gamesActive: 0,
      gamesEndspiel: 0,
      claimsOpen: 0,
      sseClients: 0,
    });
    expect(snap.claimsCreated24h).toBe(0);

    // Pruning also happens on writes, so a disabled/unread endpoint does not
    // retain process-lifetime history.
    ctx.metrics.recordClaimCreated();
    expect(
      ctx.metrics.snapshot({
        mode: "running",
        gamesActive: 0,
        gamesEndspiel: 0,
        claimsOpen: 0,
        sseClients: 0,
      }).claimsCreated24h,
    ).toBe(1);
  });
});
