import type { PaymentRail } from "@onestepchess/core";
import { eq } from "drizzle-orm";
import type { Coordinator } from "../coordinator/queue.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

export type BonusWatcherDeps = {
  readonly coordinator: Coordinator;
  readonly db: Db;
  readonly rail: PaymentRail;
  readonly now: () => number;
};

/** Opt-in is a human action, so it is observed here at watcher cadence — the
 * 2 s funding executor never polls for it (F1, spec 2026-08-26). Opt-in is
 * checked before expiry so a player who opted in while an in-flight job
 * blocked expiry is never expired out from under their opt-in. */
export async function runBonusWatcher(deps: BonusWatcherDeps): Promise<number> {
  const unresolved = deps.db
    .select({
      player: schema.bonuses.player,
      optInDeadlineAt: schema.bonuses.optInDeadlineAt,
    })
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
    if (account.optedInUsdc) {
      await deps.coordinator.dispatch({
        type: "FundingPendingAlgoSkipped",
        payload: { player: bonus.player },
        refIds: [bonus.player],
      });
      const result = await deps.coordinator.dispatch<
        { player: string },
        { changed: boolean }
      >({
        type: "BonusOptInObserved",
        payload: { player: bonus.player },
        refIds: [bonus.player],
      });
      if (result.kind === "ok" && result.result.changed) advanced += 1;
      continue;
    }
    if (deps.now() >= bonus.optInDeadlineAt) {
      await deps.coordinator.dispatch({
        type: "BonusOptInExpired",
        payload: { player: bonus.player },
        refIds: [bonus.player],
      });
    }
  }
  return advanced;
}
