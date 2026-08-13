import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { CoordinatorViews } from "../../coordinator/views.js";
import { schema } from "../../db/open.js";
import type { PublicStats } from "../../incentives/stats.js";
import { type AppEnv, AppError } from "../app.js";
import { playerView } from "../views.js";
import { type SessionAuthDeps, sessionAuth } from "./auth.js";

export type DiscoveryDeps = Pick<
  SessionAuthDeps,
  "db" | "config" | "jwtSecret" | "now"
> & {
  readonly views: CoordinatorViews;
  readonly mode: () => "running" | "paused";
  readonly rail: { readonly treasuryAddress: string };
  readonly publicBaseUrl: string;
  readonly publicStats?: PublicStats;
};

export function registerDiscoveryRoutes(
  app: Hono<AppEnv>,
  deps: DiscoveryDeps,
): void {
  app.get("/api/v1/meta", (c) => {
    const config = deps.config();
    const state = deps.db
      .select()
      .from(schema.systemState)
      .where(eq(schema.systemState.id, 1))
      .get();
    return c.json({
      name: "One Step Chess",
      network: {
        caip2: config.CAIP2,
        usdcAssetId: config.USDC_ASA,
        treasuryAddress: deps.rail.treasuryAddress,
        facilitatorUrl: config.FACILITATOR_URL,
        explorerBaseUrl: config.EXPLORER_BASE_URL,
        algodUrl: config.ALGOD_URL,
      },
      economics: {
        humanStakeMicroUsdc: config.HUMAN_STAKE,
        agentStakeMicroUsdc: config.AGENT_STAKE,
        endspielStakeMicroUsdc: config.ENDSPIEL_STAKE,
        drawFeeMicroUsdc: config.DRAW_FEE,
        protocolFeeBps: config.PROTOCOL_FEE_BPS,
        humanTargetMult: config.HUMAN_TARGET_MULT,
      },
      timing: {
        claimTtlSeconds: {
          human: config.CLAIM_TTL_HUMAN,
          agent: config.CLAIM_TTL_AGENT,
          endspiel: config.CLAIM_TTL_ENDSPIEL,
        },
        timerRevealSeconds: config.TIMER_REVEAL_SECONDS,
        minPlyIntervalSeconds: config.MIN_PLY_INTERVAL_SECONDS,
        cooldownPlies: config.COOLDOWN_PLIES,
        nextGameNudgeSeconds: config.NEXT_GAME_NUDGE_SECONDS,
      },
      quotas: {
        human: null,
        agent: config.QUOTA_AGENT,
        demo: config.QUOTA_DEMO,
        windowMinutes: 60,
      },
      pool: {
        target: config.GAME_POOL_TARGET,
        active: [...deps.views.games.values()].filter(
          (game) => game.status === "active",
        ).length,
        endspiel: [...deps.views.games.values()].filter(
          (game) => game.status === "endspiel",
        ).length,
      },
      status: { mode: deps.mode(), banner: state?.banner ?? null },
      turnstileSiteKey: config.TURNSTILE_SITE_KEY,
      banners: {
        tower: config.TOWER_BANNER_ENABLED,
        championship: config.CHAMP_BANNER_ENABLED,
      },
      // The stats strip ships dark; present only when PUBLIC_STATS_ENABLED and
      // the boot-rebuilt counters are wired (F16 step 4).
      ...(config.PUBLIC_STATS_ENABLED && deps.publicStats !== undefined
        ? { stats: deps.publicStats.snapshot() }
        : {}),
      rules:
        "real game, one move at a time. play in the fog against bots and humans",
      docs: {
        llms: `${deps.publicBaseUrl}/llms.txt`,
        openapi: `${deps.publicBaseUrl}/api/v1/openapi.json`,
        mcpPackage: "@onestepchess/mcp",
        agentKitPackage: "@onestepchess/agent-kit",
        repo: "https://github.com/sergeyshemyakov/onestepchess",
      },
    });
  });
  app.get("/api/v1/my/profile", sessionAuth(deps), (c) => {
    const player = deps.db
      .select()
      .from(schema.players)
      .where(eq(schema.players.address, c.get("session").address))
      .get();
    if (player === undefined)
      throw new AppError("UNAUTHENTICATED", { hint: "unknown player" });
    return c.json(playerView(player));
  });
}
