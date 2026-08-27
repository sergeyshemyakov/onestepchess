import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import type { AdminOverview } from "../api/schemas.js";
import type { AdminClient } from "./client.js";

type AdminOverviewState = {
  readonly access: "probing" | "allowed" | "denied" | "error";
  readonly overview: AdminOverview | null;
  readonly error: string | null;
  /** Completion time of the last successful fetch, for the "data as of" stamp. */
  readonly loadedAt: number | null;
};

/** The admin console is an on-demand tool: it reads once on open and again
 * only when the operator asks (spec 2026-08-27). No timer, and no
 * `document.hidden` gate — opening the page in a background tab must still
 * load, or the console never leaves its skeleton. */
export function useAdminOverview(client: AdminClient) {
  const [reloads, setReloads] = useState(0);
  const [state, setState] = useState<AdminOverviewState>({
    access: "probing",
    overview: null,
    error: null,
    loadedAt: null,
  });

  const refresh = useCallback(() => {
    setReloads((current) => current + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies(reloads): bumping reloads repeats the same request on operator demand
  useEffect(() => {
    let stopped = false;
    client
      .getAdminOverview()
      .then((overview) => {
        if (stopped) return;
        setState({
          access: "allowed",
          overview,
          error: null,
          loadedAt: Date.now(),
        });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({
            access: "denied",
            overview: null,
            error: null,
            loadedAt: null,
          });
          return;
        }
        setState((current) => ({
          access: current.overview === null ? "error" : "allowed",
          overview: current.overview,
          error:
            error instanceof ApiError
              ? error.envelope.hint
              : "admin overview unavailable",
          loadedAt: current.loadedAt,
        }));
      });
    return () => {
      stopped = true;
    };
  }, [client, reloads]);

  return { ...state, refresh };
}
