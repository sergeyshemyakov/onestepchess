import type { Rng } from "@onestepchess/core";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { generateName } from "../names.js";

// Referral capture (server spec F15 step 3): first touch wins and is immutable,
// bad/self codes are ignored silently, and a fresh human registration carrying
// no ref of its own inherits a linking guest's referrer.

/** Resolve a referral code to the referrer's address, or null when the code is
 * unknown or belongs to the resolving player themselves. Never throws — a bad
 * ref must never block registration or a guest claim. */
export function resolveReferrer(
  db: Db,
  code: string | undefined | null,
  self: string,
): string | null {
  if (code === undefined || code === null || code === "") return null;
  const row = db
    .select({ address: schema.players.address })
    .from(schema.players)
    .where(eq(schema.players.refCode, code))
    .get();
  if (row === undefined || row.address === self) return null;
  return row.address;
}

/** A unique human invite slug (names.ts style), distinct from every existing
 * ref_code. Humans are minted one at registration. */
export function freeRefCode(db: Db, rng: Rng): string {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const code = generateName(rng);
    const taken = db
      .select({ address: schema.players.address })
      .from(schema.players)
      .where(eq(schema.players.refCode, code))
      .get();
    if (taken === undefined) return code;
  }
  throw new Error("word list exhausted generating a ref code");
}

/** Increment a referrer's joined counter (F15 step 3), in the caller's txn. */
export function bumpRefJoined(db: Db, referrer: string): void {
  db.update(schema.players)
    .set({ refJoined: sql`${schema.players.refJoined} + 1` })
    .where(eq(schema.players.address, referrer))
    .run();
}
