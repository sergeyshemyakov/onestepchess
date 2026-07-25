import { useCallback, useEffect, useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import { fetchReplayCached } from "../api/replayCache.js";
import type { ReplayView } from "../api/schemas.js";

export type ReplayLoad =
  | { readonly gameId: string | undefined; readonly kind: "loading" }
  | {
      readonly gameId: string;
      readonly kind: "ready";
      readonly replay: ReplayView;
    }
  | {
      readonly gameId: string | undefined;
      readonly kind: "missing";
      readonly hint?: string;
    }
  | {
      readonly gameId: string | undefined;
      readonly kind: "failed";
      readonly hint: string;
    };

/** Shared cached replay request state for full and digest replay surfaces. */
export function useReplay(
  client: ApiClient,
  gameId: string | undefined,
): {
  readonly load: ReplayLoad;
  readonly retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<ReplayLoad>({
    gameId,
    kind: "loading",
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies(attempt): incrementing attempt intentionally repeats the same cached request inputs
  useEffect(() => {
    setLoad({ gameId, kind: "loading" });
    if (gameId === undefined) {
      setLoad({ gameId, kind: "missing" });
      return;
    }
    let cancelled = false;
    fetchReplayCached(client, gameId)
      .then((replay) => {
        if (!cancelled) setLoad({ gameId, kind: "ready", replay });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setLoad({ gameId, kind: "missing", hint: error.envelope.hint });
          return;
        }
        setLoad({
          gameId,
          kind: "failed",
          hint:
            error instanceof ApiError
              ? error.envelope.hint
              : "replay unavailable — try again",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, client, gameId]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return {
    load: load.gameId === gameId ? load : { gameId, kind: "loading" as const },
    retry,
  };
}
