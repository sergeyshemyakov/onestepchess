import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

const DAY_MS = 86_400_000;
export const BONUS_SKIP_USDC_MICRO = 500_000;
export const BONUS_SKIP_ALGO_MICRO = 500_000;

/** A wallet already holding both playable USDC and fee ALGO gets no starter
 * stake offer at all — only such wallets skip it; a wallet missing either leg
 * still sees the full flow so it ends up able to play. */
export function hasSufficientBalancesForStarterStake(balances: {
  readonly usdcMicroUsdc: number;
  readonly algoMicroAlgo: number;
}) {
  return (
    balances.usdcMicroUsdc >= BONUS_SKIP_USDC_MICRO &&
    balances.algoMicroAlgo >= BONUS_SKIP_ALGO_MICRO
  );
}

export type BonusLifecycleDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly config: () => ServerConfig;
};

export type BonusEligibilityFacts = {
  readonly kind: "human" | "agent" | "guest";
  readonly movedDemo: boolean;
  readonly alreadyClaimed: boolean;
  readonly enabled: boolean;
  readonly claimedToday: number;
  readonly dailyCap: number;
};

export type BonusEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: "kind" | "demo" | "claimed" | "disabled" | "cap";
    };

export function evaluateBonusEligibility(
  facts: BonusEligibilityFacts,
): BonusEligibility {
  if (facts.kind !== "human") return { eligible: false, reason: "kind" };
  if (!facts.movedDemo) return { eligible: false, reason: "demo" };
  if (facts.alreadyClaimed) return { eligible: false, reason: "claimed" };
  if (!facts.enabled) return { eligible: false, reason: "disabled" };
  if (facts.claimedToday >= facts.dailyCap)
    return { eligible: false, reason: "cap" };
  return { eligible: true };
}

export function utcDayBounds(now: number): {
  readonly start: number;
  readonly end: number;
} {
  const date = new Date(now);
  const start = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  return { start, end: start + DAY_MS };
}

function factsForPlayer(
  deps: Pick<BonusLifecycleDeps, "db" | "config">,
  playerAddress: string,
  now: number,
): BonusEligibilityFacts | null {
  const player = deps.db
    .select({ kind: schema.players.kind })
    .from(schema.players)
    .where(eq(schema.players.address, playerAddress))
    .get();
  if (player === undefined) return null;
  const movedDemo =
    deps.db
      .select({ id: schema.claims.id })
      .from(schema.claims)
      .where(
        and(
          eq(schema.claims.player, playerAddress),
          eq(schema.claims.demo, true),
          eq(schema.claims.status, "moved"),
        ),
      )
      .limit(1)
      .get() !== undefined;
  const alreadyClaimed =
    deps.db
      .select({ player: schema.bonuses.player })
      .from(schema.bonuses)
      .where(eq(schema.bonuses.player, playerAddress))
      .get() !== undefined;
  const { start, end } = utcDayBounds(now);
  const claimedToday = Number(
    deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.bonuses)
      .where(
        and(
          gte(schema.bonuses.claimedAt, start),
          lt(schema.bonuses.claimedAt, end),
        ),
      )
      .get()?.count ?? 0,
  );
  const config = deps.config();
  return {
    kind: player.kind,
    movedDemo,
    alreadyClaimed,
    enabled: config.BONUS_ENABLED,
    claimedToday,
    dailyCap: config.BONUS_DAILY_CAP,
  };
}

export function bonusProfileStatus(
  deps: Pick<BonusLifecycleDeps, "db" | "config">,
  playerAddress: string,
  now: number,
): {
  readonly status: "available" | "claimed" | "opted_in" | "funded" | "expired";
  readonly algoTxid?: string;
  readonly algoReady?: boolean;
} | null {
  const row = deps.db
    .select({
      status: schema.bonuses.status,
      algoTxid: schema.bonuses.algoTxid,
    })
    .from(schema.bonuses)
    .where(eq(schema.bonuses.player, playerAddress))
    .get();
  if (row !== undefined)
    return {
      status: row.status,
      ...(row.algoTxid === null ? {} : { algoTxid: row.algoTxid }),
    };
  const facts = factsForPlayer(deps, playerAddress, now);
  return facts !== null && evaluateBonusEligibility(facts).eligible
    ? { status: "available" }
    : null;
}

export function retryAfterUtcMidnight(now: number): number {
  return Math.max(1, Math.ceil((utcDayBounds(now).end - now) / 1_000));
}

export function registerBonusCommands(deps: BonusLifecycleDeps): void {
  deps.coordinator.register(
    "BonusClaimed",
    (ctx, payload: { readonly player: string; readonly claimIp: string }) => {
      const facts = factsForPlayer(deps, payload.player, ctx.now);
      if (facts === null) return { status: "not_eligible" as const };
      const eligibility = evaluateBonusEligibility(facts);
      if (!eligibility.eligible) {
        if (eligibility.reason === "disabled")
          return {
            status: "unavailable" as const,
            reason: "disabled" as const,
          };
        if (eligibility.reason === "cap")
          return {
            status: "unavailable" as const,
            reason: "cap" as const,
            retryAfterSeconds: retryAfterUtcMidnight(ctx.now),
          };
        return { status: "not_eligible" as const };
      }
      const config = deps.config();
      deps.db
        .insert(schema.bonuses)
        .values({
          player: payload.player,
          status: "claimed",
          algoAmount: config.BONUS_ALGO_MICRO,
          usdcAmount: config.BONUS_USDC_MICRO,
          claimIp: payload.claimIp,
          claimedAt: ctx.now,
          optInDeadlineAt: ctx.now + config.BONUS_OPTIN_EXPIRY_DAYS * DAY_MS,
        })
        .run();
      ctx.appendEvent("bonus_updated", payload.player, { status: "claimed" });
      return {
        status: "claimed" as const,
        claimedAt: new Date(ctx.now).toISOString(),
      };
    },
  );

  deps.coordinator.register(
    "BonusOptInObserved",
    (ctx, payload: { readonly player: string }) => {
      const bonus = deps.db
        .select()
        .from(schema.bonuses)
        .where(eq(schema.bonuses.player, payload.player))
        .get();
      if (bonus === undefined || bonus.status !== "claimed") {
        return { changed: false as const };
      }
      deps.db
        .update(schema.bonuses)
        .set({ status: "opted_in", optedInAt: ctx.now })
        .where(eq(schema.bonuses.player, payload.player))
        .run();
      ctx.appendEvent("bonus_updated", payload.player, { status: "opted_in" });
      return { changed: true as const };
    },
  );
}
