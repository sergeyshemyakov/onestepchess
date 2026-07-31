import type { PaymentRail } from "@onestepchess/core";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { type AppEnv, AppError } from "../http/app.js";
import { bonusOptInBodySchema } from "../http/contracts.js";
import { clientIp } from "../http/middleware/client-ip.js";
import { type SessionAuthDeps, sessionAuth } from "../http/routes/auth.js";
import { parseJsonBody } from "../http/validation.js";
import { isSafeBonusOptIn } from "./optin.js";

export type BonusRouteDeps = SessionAuthDeps & {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly config: () => ServerConfig;
  readonly trustProxyHops: number;
};

function claimedBonus(deps: BonusRouteDeps, player: string): void {
  const row = deps.db
    .select({ status: schema.bonuses.status })
    .from(schema.bonuses)
    .where(eq(schema.bonuses.player, player))
    .get();
  if (row?.status !== "claimed") {
    throw new AppError("BONUS_NOT_ELIGIBLE", {
      hint: "a claimed starter stake awaiting USDC opt-in is required",
    });
  }
}

export function registerBonusRoutes(
  app: Hono<AppEnv>,
  deps: BonusRouteDeps,
): void {
  const auth = sessionAuth(deps);

  app.post("/api/v1/my/bonus/claim", auth, async (c) => {
    const session = c.get("session");
    if (session.kind !== "human") {
      throw new AppError("BONUS_NOT_ELIGIBLE", {
        hint: "starter stakes are available to eligible humans only",
      });
    }
    const result = await deps.coordinator.dispatch<
      { player: string; claimIp: string },
      | { status: "not_eligible" }
      | {
          status: "unavailable";
          reason: "disabled" | "cap";
          retryAfterSeconds?: number;
        }
      | { status: "claimed"; claimedAt: string }
    >({
      type: "BonusClaimed",
      payload: {
        player: session.address,
        claimIp: clientIp(c, deps.trustProxyHops),
      },
      refIds: [session.address],
    });
    if (result.kind !== "ok") throw new Error("bonus claim deprioritized");
    if (result.result.status === "not_eligible") {
      throw new AppError("BONUS_NOT_ELIGIBLE", {
        hint: "move one demo claim first; starter stakes are one per human",
      });
    }
    if (result.result.status === "unavailable") {
      throw new AppError("BONUS_UNAVAILABLE", {
        hint:
          result.result.reason === "cap"
            ? "today's starter stakes are gone — back tomorrow"
            : "starter stakes are currently disabled",
        ...(result.result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.result.retryAfterSeconds }),
      });
    }
    return c.json({
      bonus: {
        status: result.result.status,
        claimedAt: result.result.claimedAt,
      },
    });
  });

  app.get("/api/v1/my/bonus/optin-txn", auth, async (c) => {
    const session = c.get("session");
    if (session.kind !== "human") {
      throw new AppError("BONUS_NOT_ELIGIBLE", {
        hint: "starter stakes are available to eligible humans only",
      });
    }
    claimedBonus(deps, session.address);
    try {
      return c.json({
        unsignedTxnB64: await deps.rail.buildOptInTxn(session.address),
      });
    } catch {
      throw new AppError("DEPENDENCY_UNAVAILABLE", {
        hint: "unable to build the opt-in transaction; retry shortly",
        retryAfterSeconds: 5,
      });
    }
  });

  app.post("/api/v1/my/bonus/optin", auth, async (c) => {
    const session = c.get("session");
    if (session.kind !== "human") {
      throw new AppError("BONUS_NOT_ELIGIBLE", {
        hint: "starter stakes are available to eligible humans only",
      });
    }
    claimedBonus(deps, session.address);
    const body = await parseJsonBody(
      bonusOptInBodySchema,
      c.req,
      "signedTxnB64 is required",
    );
    if (!isSafeBonusOptIn(body.signedTxnB64, session.address, deps.config())) {
      throw new AppError("OPTIN_INVALID", {
        hint: "signed transaction is not the exact requested USDC opt-in",
      });
    }
    const result = await deps.rail.submitSignedTransaction(body.signedTxnB64);
    if (!result.ok && result.reason === "rejected") {
      throw new AppError("OPTIN_INVALID", {
        hint: result.detail?.slice(0, 500) ?? "algod rejected the opt-in",
      });
    }
    return c.json({ status: "watching" as const }, 202);
  });
}
