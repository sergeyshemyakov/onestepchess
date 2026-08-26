import { and, eq, inArray, isNull } from "drizzle-orm";
import { type ClaimDeps, legalMove } from "./coordinator/claims.js";
import { schema } from "./db/open.js";

/** Recovery deliberately consults the rail before touching a settling intent:
 * a confirmed client payment must be committed, while an unknown old payment
 * is definitively failed so the normal expiry command can release its slot. */
const RECOVERY_POLL_MS = 1_000;

export type SettlingSweepResult = {
  readonly nextRecoveryAt: number | null;
  /** Rail consultations that errored this pass. Zero means every stranded
   * intent's chain status was actually determined — the boot gate's
   * clearing condition (F3, spec 2026-08-26). */
  readonly errorCount: number;
};

export async function recoverSettlingIntents(
  deps: ClaimDeps,
  logger?: { error(obj: object, msg: string): void },
): Promise<SettlingSweepResult> {
  const now = deps.now();
  let errorCount = 0;
  let nextRecoveryAt: number | null = null;
  const schedule = (at: number): void => {
    nextRecoveryAt =
      nextRecoveryAt === null ? at : Math.min(nextRecoveryAt, at);
  };
  // `verified` intents are swept too: a crash or a thrown verify/settle call
  // can strand an intent before it ever reaches `settling`, and any
  // unresolved in-flight intent blocks its claim's expiry indefinitely.
  const intents = deps.db
    .select()
    .from(schema.paymentIntents)
    .where(inArray(schema.paymentIntents.status, ["verified", "settling"]))
    .all();
  for (const intent of intents) {
    // One unrecoverable intent must not abort the sweep for the rest of the
    // intents or the overdue-claim expiry below.
    try {
      const status = await deps.rail.getTransactionStatus(intent.clientTxid);
      if (status.status === "confirmed") {
        const claim = deps.db
          .select()
          .from(schema.claims)
          .where(eq(schema.claims.id, intent.claimId))
          .get();
        if (claim === undefined || claim.status !== "open") continue;
        const normalized = legalMove(deps, claim, intent.moveUci);
        if (!normalized.ok)
          throw new Error(`stored move no longer legal for ${intent.id}`);
        const response = deps.rail.encodePaymentResponse(
          intent.settleTxid ?? intent.clientTxid,
        );
        await deps.coordinator.dispatch({
          type: "MoveSettled",
          payload: {
            claimId: claim.id,
            player: claim.player,
            move: normalized.move,
            clientTxid: intent.clientTxid,
            txid: intent.settleTxid ?? intent.clientTxid,
            response,
          },
        });
        continue;
      }
      const boundary =
        intent.updatedAt +
        deps.config().PAYMENT_RECOVERY_TIMEOUT_SECONDS * 1_000;
      const beyondValidity =
        status.status === "not_found" &&
        (intent.lastValidRound === null
          ? now >= boundary
          : status.currentRound > intent.lastValidRound);
      if (beyondValidity) {
        await deps.coordinator.dispatch({
          type: "IntentFailed",
          payload: {
            clientTxid: intent.clientTxid,
            failureCode:
              intent.lastValidRound === null
                ? "recovery_timeout"
                : "validity_expired",
          },
        });
        continue;
      }
      schedule(
        status.status === "not_found" && intent.lastValidRound === null
          ? Math.min(boundary, now + RECOVERY_POLL_MS)
          : now + RECOVERY_POLL_MS,
      );
    } catch (error) {
      errorCount += 1;
      logger?.error(
        { err: error, intentId: intent.id },
        "payment intent recovery failed; will retry",
      );
      schedule(now + RECOVERY_POLL_MS);
    }
  }
  const overdue = deps.db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.status, "open"))
    .all()
    .filter((claim) => claim.deadline <= now);
  for (const claim of overdue)
    await deps.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: claim.id },
    });
  return { nextRecoveryAt, errorCount };
}

/** Boot-gate recovery (F3, spec 2026-08-26): repeats the settling-intent
 * sweep until one pass completes with zero rail errors, then recovers
 * unresolved terminal games. Returns false only when `shouldContinue` asks
 * it to stop (shutdown) — against a permanently-down rail it retries
 * indefinitely, keeping the boot pause cause active. */
export async function completeBootRecovery(
  deps: ClaimDeps,
  options: {
    readonly logger: { error(obj: object, msg: string): void };
    readonly retryDelayMs: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly shouldContinue?: () => boolean;
  },
): Promise<boolean> {
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  while (options.shouldContinue?.() ?? true) {
    const sweep = await recoverSettlingIntents(deps, options.logger);
    if (sweep.errorCount === 0) {
      // An empty sweep makes no rail call at all, so a zero error count is
      // not yet proof the chain is reachable — a treasury balance read is
      // the explicit canary (F3 review, spec 2026-08-26).
      try {
        await deps.rail.getBalances(deps.rail.treasuryAddress);
      } catch (error) {
        options.logger.error(
          { err: error },
          "boot canary failed; gate stays closed",
        );
        await sleep(options.retryDelayMs);
        continue;
      }
      await recoverUnresolvedTerminalGames(deps);
      return true;
    }
    await sleep(options.retryDelayMs);
  }
  return false;
}

export async function recoverUnresolvedTerminalGames(
  deps: Pick<ClaimDeps, "coordinator" | "db">,
): Promise<void> {
  const games = deps.db
    .select({ id: schema.games.id })
    .from(schema.games)
    .where(
      and(
        inArray(schema.games.status, ["finished", "aborted"]),
        isNull(schema.games.resolvedAt),
      ),
    )
    .all();
  for (const game of games) {
    await deps.coordinator.dispatch({
      type: "GameFinished",
      payload: { gameId: game.id },
      refIds: [game.id],
    });
  }
}
