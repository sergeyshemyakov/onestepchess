import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import type { AdminOverview } from "../api/schemas.js";
import type { AdminClient } from "./client.js";

export const ADMIN_POLL_MS = 30_000;

type AdminOverviewState = {
  readonly access: "probing" | "allowed" | "denied" | "error";
  readonly overview: AdminOverview | null;
  readonly error: string | null;
};

export function useAdminOverview(client: AdminClient) {
  const etag = useRef<string | undefined>(undefined);
  const pollNow = useRef<() => void>(() => undefined);
  const [state, setState] = useState<AdminOverviewState>({
    access: "probing",
    overview: null,
    error: null,
  });

  const refresh = useCallback(() => {
    pollNow.current();
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (stopped || document.hidden) return;
      timer = setTimeout(() => void poll(), ADMIN_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.hidden) return;
      try {
        const result = await client.getAdminOverview(etag.current);
        if (stopped) return;
        if (result.etag !== null) etag.current = result.etag;
        if (result.kind === "data") {
          setState({
            access: "allowed",
            overview: result.overview,
            error: null,
          });
        } else {
          setState((current) => ({
            ...current,
            access: current.overview === null ? "probing" : "allowed",
            error: null,
          }));
        }
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({ access: "denied", overview: null, error: null });
          return;
        }
        setState((current) => ({
          access: current.overview === null ? "error" : "allowed",
          overview: current.overview,
          error:
            error instanceof ApiError
              ? error.envelope.hint
              : "admin overview unavailable",
        }));
      } finally {
        schedule();
      }
    };

    const onVisibility = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!document.hidden) void poll();
    };

    pollNow.current = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      stopped = true;
      pollNow.current = () => undefined;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client]);

  return { ...state, refresh };
}
