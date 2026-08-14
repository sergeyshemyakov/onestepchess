import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

/** Drops settled payment intents past `retentionDays`.
 *
 * A settled intent is kept only to answer a client that retries the same
 * `X-PAYMENT` header: the row replays the stored receipt instead of charging
 * twice (`claims.ts` settled branch). That retry window is bounded by the claim
 * TTL — minutes — so a row older than the retention window can no longer be
 * reached by any live request, and its `client_txid` uniqueness has stopped
 * mattering because the transaction's `last_valid_round` has long since passed
 * on chain. Unsettled rows are never touched: 'verified'/'settling' are money
 * in flight that reconciliation sums, and 'failed' still carries the failure
 * code a retry must see.
 */
export function pruneSettledPaymentIntents(
  db: Db,
  now: number,
  retentionDays: number,
): number {
  const cutoff = now - retentionDays * 86_400_000;
  return db
    .delete(schema.paymentIntents)
    .where(
      and(
        eq(schema.paymentIntents.status, "settled"),
        lt(schema.paymentIntents.updatedAt, cutoff),
      ),
    )
    .run().changes;
}
