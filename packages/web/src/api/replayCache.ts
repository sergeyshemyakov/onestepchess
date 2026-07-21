import type { ApiClient } from "./client.js";
import type { ReplayView } from "./schemas.js";

// §5.1 replay cache: immutable once fetched (nickname live-join staleness
// within a session is accepted). In-flight requests are deduped so a hero
// card and a quick-view opening together cost one request. Errors are not
// cached — a failed fetch retries on the next open (no retry loop is
// started here; NotFound surfaces render from the thrown error).

const cache = new Map<string, ReplayView>();
const inflight = new Map<string, Promise<ReplayView>>();

export async function fetchReplayCached(
  client: ApiClient,
  gameId: string,
): Promise<ReplayView> {
  const cached = cache.get(gameId);
  if (cached !== undefined) return cached;
  const pending = inflight.get(gameId);
  if (pending !== undefined) return pending;
  const request = client
    .getReplay(gameId)
    .then((replay) => {
      cache.set(gameId, replay);
      return replay;
    })
    .finally(() => {
      inflight.delete(gameId);
    });
  inflight.set(gameId, request);
  return request;
}

export function clearReplayCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
