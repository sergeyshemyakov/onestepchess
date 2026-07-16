import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { CoordinatorViews } from "../../coordinator/views.js";
import { schema } from "../../db/open.js";
import { type AppEnv, AppError } from "../app.js";
import { type AuthRouteDeps, sessionAuth } from "./auth.js";

export type DiscoveryDeps = Pick<
  AuthRouteDeps,
  "db" | "config" | "jwtSecret" | "now"
> & {
  readonly views: CoordinatorViews;
  readonly mode: () => "running" | "paused";
  readonly rail: { readonly treasuryAddress: string };
  readonly publicBaseUrl: string;
  readonly staticDir?: string;
};

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

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
        human: config.QUOTA_HUMAN,
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
      rules:
        "One move at a time. Your position and legal moves are private until the game resolves.",
      docs: {
        llms: `${deps.publicBaseUrl}/llms.txt`,
        openapi: `${deps.publicBaseUrl}/api/v1/openapi.json`,
        mcpPackage: "@onestepchess/mcp",
        agentKitPackage: "@onestepchess/agent-kit",
        repo: "https://github.com/sergeyshemyakov/onestepchess",
      },
    });
  });
  app.get(
    "/api/v1/my/profile",
    sessionAuth(deps as unknown as AuthRouteDeps),
    (c) => {
      const player = deps.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, c.get("session").address))
        .get();
      if (player === undefined)
        throw new AppError("UNAUTHENTICATED", { hint: "unknown player" });
      return c.json({
        address: player.address,
        kind: player.kind,
        nickname: player.nickname,
        createdAt: new Date(player.createdAt).toISOString(),
      });
    },
  );
  app.get("*", (c) => {
    if (
      deps.staticDir === undefined ||
      c.req.path.startsWith("/api/") ||
      c.req.path === "/healthz"
    )
      return c.notFound();
    const root = resolve(deps.staticDir);
    const relative = normalize(c.req.path.replace(/^\//, ""));
    const candidate = resolve(root, relative);
    if (
      candidate.startsWith(root) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const immutable =
        relative.startsWith("assets/") && /-[A-Za-z0-9_-]{6,}\./.test(relative);
      return c.body(readFileSync(candidate), 200, {
        "Content-Type": contentType(candidate),
        "Cache-Control": immutable
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
    }
    const index = join(root, "index.html");
    if (!existsSync(index)) return c.notFound();
    return c.body(readFileSync(index, "utf8"), 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  });
}
