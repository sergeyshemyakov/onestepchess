import { and, eq, inArray, isNull } from "drizzle-orm";
import { type ClaimDeps, legalMove } from "./coordinator/claims.js";
import { schema } from "./db/open.js";

/** Recovery deliberately consults the rail before touching a settling intent:
 * a confirmed client payment must be committed, while an unknown old payment
 * is definitively failed so the normal expiry command can release its slot. */
const RECOVERY_POLL_MS = 1_000;

export async function recoverSettlingIntents(
  deps: ClaimDeps,
): Promise<number | null> {
  const now = deps.now();
  let nextRecoveryAt: number | null = null;
  const intents = deps.db
    .select()
    .from(schema.paymentIntents)
    .where(eq(schema.paymentIntents.status, "settling"))
    .all();
  for (const intent of intents) {
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
      intent.updatedAt + deps.config().PAYMENT_RECOVERY_TIMEOUT_SECONDS * 1_000;
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
    const candidate =
      status.status === "not_found" && intent.lastValidRound === null
        ? Math.min(boundary, now + RECOVERY_POLL_MS)
        : now + RECOVERY_POLL_MS;
    nextRecoveryAt =
      nextRecoveryAt === null ? candidate : Math.min(nextRecoveryAt, candidate);
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
  return nextRecoveryAt;
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
