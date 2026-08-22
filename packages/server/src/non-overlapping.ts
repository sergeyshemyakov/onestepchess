/** Executor passes are fired from bare intervals, so a pass that outlives its
 * tick would run concurrently with the next one — two passes broadcasting the
 * same prepared payout bytes is what double-paid winners on 2026-08-22. The
 * guard drops ticks while a pass is in flight instead of queueing them: every
 * pass re-reads its work from the database, so the next tick loses nothing. */
export function nonOverlapping(pass: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await pass();
    } finally {
      inFlight = false;
    }
  };
}
