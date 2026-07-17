import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ApiClient } from "../api/client.js";
import type { PlayerView } from "../api/schemas.js";
import { disconnectWalletIfLoaded } from "../wallet/lazy.js";

export type SessionState =
  | { readonly status: "probing" }
  | { readonly status: "out" }
  | { readonly status: "in"; readonly player: PlayerView };

type SessionValue = {
  readonly session: SessionState;
  readonly signedIn: (player: PlayerView) => void;
  readonly droppedByServer: () => void;
  readonly logout: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

/** §5.2 — the cookie is httpOnly, so the boot probe (`GET /my/profile`)
 * is the only way to know: 200 → in, 401 → out. */
export function SessionProvider(props: {
  readonly client: ApiClient;
  readonly children: ReactNode;
}) {
  const [session, setSession] = useState<SessionState>({ status: "probing" });
  const { client } = props;

  useEffect(() => {
    let cancelled = false;
    client
      .probeProfile()
      .then((player) => {
        if (cancelled) return;
        setSession(
          player === null ? { status: "out" } : { status: "in", player },
        );
      })
      .catch(() => {
        if (!cancelled) setSession({ status: "out" });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const signedIn = useCallback((player: PlayerView) => {
    setSession({ status: "in", player });
  }, []);

  const droppedByServer = useCallback(() => {
    setSession((current) =>
      current.status === "in" ? { status: "out" } : current,
    );
  }, []);

  const logout = useCallback(async () => {
    try {
      await client.authLogout();
    } catch {
      // revoked/expired server-side is still logged out locally
    }
    setSession({ status: "out" });
    await disconnectWalletIfLoaded().catch(() => undefined);
  }, [client]);

  const value = useMemo(
    () => ({ session, signedIn, droppedByServer, logout }),
    [session, signedIn, droppedByServer, logout],
  );

  return (
    <SessionContext.Provider value={value}>
      {props.children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession outside SessionProvider");
  return value;
}
