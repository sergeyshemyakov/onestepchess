import { sql } from "drizzle-orm";
import type { Db } from "./open.js";
import { schema } from "./open.js";

type LedgerEntry = Omit<typeof schema.ledger.$inferInsert, "id">;

/** Every ledger append updates the running balance in the same transaction
 * (server spec §4), so reconciliation and admin reads never re-sum the table. */
export function bumpLedgerBalance(
  db: Db,
  account: string,
  delta: number,
): void {
  db.insert(schema.ledgerBalances)
    .values({ account, balanceMicrousdc: delta })
    .onConflictDoUpdate({
      target: schema.ledgerBalances.account,
      set: {
        balanceMicrousdc: sql`${schema.ledgerBalances.balanceMicrousdc} + ${delta}`,
      },
    })
    .run();
}

export function appendLedgerEntry(db: Db, entry: LedgerEntry): void {
  db.insert(schema.ledger).values(entry).run();
  bumpLedgerBalance(db, entry.account, entry.deltaMicrousdc);
}
