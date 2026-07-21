import { createContext, useContext } from "react";
import type { ClaimView } from "../api/schemas.js";
import type { SseConnectionState } from "../api/sse.js";

export type ShellLiveState = {
  readonly connection: SseConnectionState | "closed";
  readonly currentClaim: ClaimView | null;
  readonly playSurfaceVisible: boolean;
};

export const ShellLiveContext = createContext<ShellLiveState | null>(null);

export function useShellLive(): ShellLiveState | null {
  return useContext(ShellLiveContext);
}
