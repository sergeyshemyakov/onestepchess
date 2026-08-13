import type { PaymentRail } from "@onestepchess/core";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { type AppEnv, AppError } from "../http/app.js";
import {
  bonusOptInBodySchema,
  bonusSweepBodySchema,
} from "../http/contracts.js";
import { clientIp } from "../http/middleware/client-ip.js";
import { type SessionAuthDeps, sessionAuth } from "../http/routes/auth.js";
import { parseJsonBody } from "../http/validation.js";
import { hasAlgoFundingCapacity } from "./funding.js";
import {
  BONUS_SKIP_ALGO_MICRO,
  hasSufficientBalancesForStarterStake,
} from "./lifecycle.js";
import { isSafeBonusOptIn } from "./optin.js";
import { isSafeBonusSweep } from "./sweep.js";

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
    let account: Awaited<ReturnType<PaymentRail["getAccountInfo"]>>;
    try {
      const [balances, accountInfo] = await Promise.all([
        deps.rail.getBalances(session.address),
        deps.rail.getAccountInfo(session.address),
      ]);
      if (hasSufficientBalancesForStarterStake(balances)) {
        throw new AppError("BONUS_NOT_ELIGIBLE", {
          hint: "this wallet already holds enough ALGO and USDC to play",
        });
      }
      account = accountInfo;
      if (
        !account.optedInUsdc &&
        balances.algoMicroAlgo < BONUS_SKIP_ALGO_MICRO
      ) {
        const treasury = await deps.rail.getBalances(deps.rail.treasuryAddress);
        const config = deps.config();
        if (
          !hasAlgoFundingCapacity(
            treasury.algoMicroAlgo,
            config.BONUS_ALGO_MICRO,
            config.TREASURY_MIN_ALGO_MICRO,
          )
        ) {
          throw new AppError("BONUS_UNAVAILABLE", {
            hint: "starter ALGO is temporarily unavailable — try again shortly",
          });
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("DEPENDENCY_UNAVAILABLE", {
        hint: "unable to check wallet balances; retry shortly",
        retryAfterSeconds: 5,
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
    if (account.optedInUsdc) {
      await deps.coordinator.dispatch({
        type: "BonusOptInObserved",
        payload: { player: session.address },
        refIds: [session.address],
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

  // A returned welcome bonus sweeps the wallet, so the sweep pair is limited
  // to players with a starter stake on record — any status: the ALGO leg can
  // arrive before the USDC opt-in completes.
  const sweepEligible = (player: string): void => {
    const row = deps.db
      .select({ status: schema.bonuses.status })
      .from(schema.bonuses)
      .where(eq(schema.bonuses.player, player))
      .get();
    if (row === undefined) {
      throw new AppError("BONUS_NOT_ELIGIBLE", {
        hint: "only wallets with a starter stake can return one",
      });
    }
  };

  app.get("/api/v1/my/bonus/sweep-txns", auth, async (c) => {
    const session = c.get("session");
    if (session.kind !== "human") {
      throw new AppError("BONUS_NOT_ELIGIBLE", {
        hint: "starter stakes are available to eligible humans only",
      });
    }
    sweepEligible(session.address);
    try {
      return c.json(await deps.rail.buildSweepTxns(session.address));
    } catch {
      throw new AppError("DEPENDENCY_UNAVAILABLE", {
        hint: "unable to build the bonus-return transactions; retry shortly",
        retryAfterSeconds: 5,
      });
    }
  });

  app.post("/api/v1/my/bonus/sweep", auth, async (c) => {
    const session = c.get("session");
    if (session.kind !== "human") {
      throw new AppError("BONUS_NOT_ELIGIBLE", {
        hint: "starter stakes are available to eligible humans only",
      });
    }
    sweepEligible(session.address);
    const body = await parseJsonBody(
      bonusSweepBodySchema,
      c.req,
      "signedTxnsB64 is required",
    );
    const legs = body.signedTxnsB64.map((signed) => ({
      signed,
      verdict: isSafeBonusSweep(
        signed,
        session.address,
        deps.rail.bonusAddress,
        deps.config(),
      ),
    }));
    if (
      legs.some(({ verdict }) => !verdict.ok) ||
      new Set(legs.map(({ verdict }) => (verdict.ok ? verdict.leg : "")))
        .size !== legs.length
    ) {
      throw new AppError("SWEEP_INVALID", {
        hint: "signed transactions are not the exact requested bonus return",
      });
    }
    // USDC first: its flat fee is budgeted by the ALGO leg's amount, so the
    // reverse order could strand the asset transfer without fee cover.
    const rank = (verdict: (typeof legs)[number]["verdict"]): number =>
      verdict.ok && verdict.leg === "usdc" ? 0 : 1;
    legs.sort((left, right) => rank(left.verdict) - rank(right.verdict));
    const txids: { leg: "algo" | "usdc"; txid: string }[] = [];
    for (const { signed, verdict } of legs) {
      if (!verdict.ok) continue;
      const result = await deps.rail.submitSignedTransaction(signed);
      if (!result.ok) {
        const partial =
          txids.length === 0
            ? ""
            : " — the other leg was already submitted; refetch the quote before retrying";
        if (result.reason === "rejected") {
          throw new AppError("SWEEP_INVALID", {
            hint: `${
              result.detail?.slice(0, 400) ?? "algod rejected the bonus return"
            }${partial}`,
          });
        }
        throw new AppError("DEPENDENCY_UNAVAILABLE", {
          hint: `unable to relay the bonus return; retry shortly${partial}`,
          retryAfterSeconds: 5,
        });
      }
      txids.push({ leg: verdict.leg, txid: result.txid });
    }
    return c.json({ status: "submitted" as const, txids });
  });
}
