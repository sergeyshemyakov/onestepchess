import type { PaymentRail } from "@onestepchess/core";
import { eq } from "drizzle-orm";
import type { Coordinator } from "../coordinator/queue.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

export type BonusWatcherDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly rail: PaymentRail;
};

export async function runBonusWatcher(deps: BonusWatcherDeps): Promise<number> {
  const unresolved = deps.db
    .select({ player: schema.bonuses.player })
    .from(schema.bonuses)
    .where(eq(schema.bonuses.status, "claimed"))
    .all();
  let advanced = 0;
  for (const bonus of unresolved) {
    let account: Awaited<ReturnType<PaymentRail["getAccountInfo"]>>;
    try {
      account = await deps.rail.getAccountInfo(bonus.player);
    } catch {
      continue;
    }
    if (!account.optedInUsdc) continue;
    const result = await deps.coordinator.dispatch<
      { player: string },
      { changed: boolean }
    >({
      type: "BonusOptInObserved",
      payload: { player: bonus.player },
      refIds: [bonus.player],
    });
    if (result.kind === "ok" && result.result.changed) advanced += 1;
  }
  return advanced;
}
