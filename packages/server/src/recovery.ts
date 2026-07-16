import { eq } from "drizzle-orm";
import { type ClaimDeps, legalMove } from "./coordinator/claims.js";
import { schema } from "./db/open.js";

/** Recovery deliberately consults the rail before touching a settling intent:
 * a confirmed client payment must be committed, while an unknown old payment
 * is definitively failed so the normal expiry command can release its slot. */
export async function recoverSettlingIntents(deps: ClaimDeps): Promise<void> {
  const now = deps.now();
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
    const stale =
      now - intent.updatedAt >=
      deps.config().PAYMENT_RECOVERY_TIMEOUT_SECONDS * 1_000;
    if (status.status === "not_found" && stale) {
      deps.db
        .update(schema.paymentIntents)
        .set({
          status: "failed",
          failureCode: "recovery_timeout",
          updatedAt: now,
        })
        .where(eq(schema.paymentIntents.id, intent.id))
        .run();
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
}
