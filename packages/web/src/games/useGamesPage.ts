import { useEffect, useState } from "react";
import type { GamesPage } from "../api/schemas.js";

/** Load one paginated games view and ignore results after unmount/input change. */
export function useGamesPage<T>(
  loadPage: (page: number) => Promise<GamesPage<T>>,
  page: number,
  version: number,
): GamesPage<T> | null {
  const [result, setResult] = useState<GamesPage<T> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(version): live events invalidate the current page without changing its query inputs
  useEffect(() => {
    let cancelled = false;
    loadPage(page)
      .then((loaded) => {
        if (!cancelled) setResult(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loadPage, page, version]);

  return result;
}
