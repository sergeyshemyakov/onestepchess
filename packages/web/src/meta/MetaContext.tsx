import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ApiClient } from "../api/client.js";
import type { Meta } from "../api/schemas.js";

type MetaState = {
  readonly meta: Meta | null;
  readonly refetch: () => void;
  readonly updateStatus: (status: Meta["status"]) => void;
};

const MetaContext = createContext<MetaState | null>(null);

/** `/meta` once at boot; a skeleton renders while pending (§5.3). SSE-driven
 * updates are Release 2 — the banner refreshes on refetch. */
export function MetaProvider(props: {
  readonly client: ApiClient;
  readonly children: ReactNode;
}) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const { client } = props;

  const refetch = useCallback(() => {
    client
      .getMeta()
      .then(setMeta)
      .catch(() => {
        // keep the previous snapshot; the next refetch will retry
      });
  }, [client]);

  const updateStatus = useCallback((status: Meta["status"]) => {
    setMeta((current) => (current === null ? current : { ...current, status }));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return (
    <MetaContext.Provider value={{ meta, refetch, updateStatus }}>
      {props.children}
    </MetaContext.Provider>
  );
}

export function useMeta(): MetaState {
  const value = useContext(MetaContext);
  if (value === null) throw new Error("useMeta outside MetaProvider");
  return value;
}

/** For shell chrome that also mounts on the provider-less public replay. */
export function useMetaOptional(): MetaState | null {
  return useContext(MetaContext);
}
