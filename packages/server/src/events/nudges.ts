import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";
import type { CoordinatorViews } from "../coordinator/views.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

export type NudgeDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly views: CoordinatorViews;
  readonly config: () => ServerConfig;
  readonly connectedPlayers: () => readonly string[];
};

type Candidate = {
  readonly address: string;
  readonly priority: number;
  readonly claimId: string;
};

export function registerNudgeCommands(deps: NudgeDeps): void {
  deps.coordinator.register("NudgeTick", (ctx) => {
    let activeClaimable = 0;
    let endspielClaimable = 0;
    for (const game of deps.views.games.values()) {
      if (
        game.minNextClaimAt > ctx.now ||
        deps.views.openClaimByGame.has(game.id)
      ) {
        continue;
      }
      if (game.status === "active") activeClaimable += 1;
      else endspielClaimable += 1;
    }
    const claimable = activeClaimable + endspielClaimable;
    if (claimable === 0) {
      return { claimable: 0, walked: 0, nudged: 0 };
    }

    const candidates: Candidate[] = [];
    let walked = 0;
    for (const address of deps.connectedPlayers()) {
      walked += 1;
      if (deps.views.openClaimByPlayer.has(address)) continue;
      const player = deps.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, address))
        .get();
      if (player === undefined || player.kind === "guest" || player.banned) {
        continue;
      }
      const lastMove = deps.db
        .select()
        .from(schema.claims)
        .where(
          and(
            eq(schema.claims.player, address),
            eq(schema.claims.status, "moved"),
          ),
        )
        .orderBy(desc(schema.claims.movedAt), desc(schema.claims.createdAt))
        .limit(1)
        .get();
      if (
        lastMove === undefined ||
        lastMove.nudgeDueAt === null ||
        lastMove.nudgeDueAt > ctx.now ||
        lastMove.nudgeSentAt !== null
      ) {
        continue;
      }

      const config = deps.config();
      if (player.kind === "human") {
        if (activeClaimable === 0) continue;
        const stakedLimit = player.quotaOverride ?? config.QUOTA_HUMAN;
        const hasStakedQuota =
          deps.views.claimsInWindow(address, false, ctx.now) < stakedLimit;
        const hasDemoQuota =
          deps.views.claimsInWindow(address, true, ctx.now) < config.QUOTA_DEMO;
        if (!hasStakedQuota && !hasDemoQuota) continue;
        candidates.push({
          address,
          priority: hasStakedQuota ? 0 : 1,
          claimId: lastMove.id,
        });
      } else {
        const limit = player.quotaOverride ?? config.QUOTA_AGENT;
        if (deps.views.claimsInWindow(address, false, ctx.now) >= limit) {
          continue;
        }
        candidates.push({ address, priority: 2, claimId: lastMove.id });
      }
    }

    candidates.sort((left, right) => left.priority - right.priority);
    let nudged = 0;
    for (const candidate of candidates.slice(0, 3 * claimable)) {
      const update = deps.db
        .update(schema.claims)
        .set({ nudgeSentAt: ctx.now })
        .where(
          and(
            eq(schema.claims.id, candidate.claimId),
            isNull(schema.claims.nudgeSentAt),
            lte(schema.claims.nudgeDueAt, ctx.now),
          ),
        )
        .run();
      if (update.changes === 0) continue;
      ctx.appendEvent("game_available", candidate.address, {});
      nudged += 1;
    }
    return { claimable, walked, nudged };
  });
}
