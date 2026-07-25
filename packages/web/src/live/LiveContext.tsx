import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router";
import type { ApiClient } from "../api/client.js";
import type {
  ClaimView,
  FinishedGameItem,
  GamesPage,
  OngoingGameItem,
  ProfileView,
} from "../api/schemas.js";
import {
  type EventSourceFactory,
  SseBus,
  type SseConnectionState,
  type SseEventMap,
  type SseEventType,
} from "../api/sse.js";
import { useSession } from "../auth/SessionContext.jsx";
import { ShareSheet } from "../components/ShareSheet.jsx";
import { ShellLiveContext } from "../components/ShellLiveContext.js";
import { useToasts } from "../components/Toasts.jsx";
import { explorerTxUrl } from "../lib/explorer.js";
import { formatMicroUsdc } from "../lib/format.js";
import { readSfx } from "../lib/storage.js";
import { useMeta } from "../meta/MetaContext.jsx";

export type LiveEvent = {
  readonly [Type in SseEventType]: {
    readonly type: Type;
    readonly payload: SseEventMap[Type];
    readonly seq: number;
  };
}[SseEventType];

type LiveValue = {
  readonly connection: SseConnectionState | "closed";
  readonly currentClaim: ClaimView | null;
  readonly profile: ProfileView | null;
  readonly ongoing: GamesPage<OngoingGameItem> | null;
  readonly finished: GamesPage<FinishedGameItem> | null;
  readonly lastEvent: LiveEvent | null;
  readonly gamesVersion: number;
  readonly playPulse: number;
  readonly consumePlayNudge: () => void;
  readonly playSurfaceVisible: boolean;
  readonly setPlaySurfaceVisible: (visible: boolean) => void;
  readonly trackClaim: (claim: ClaimView | null) => void;
  readonly refreshAll: () => void;
};

const LiveContext = createContext<LiveValue | null>(null);

function alertExpiring(deadline: string): () => void {
  if (typeof document === "undefined" || !document.hidden) {
    return () => undefined;
  }
  const original = document.title;
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(deadline) - Date.now()) / 1_000),
  );
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  document.title = `⏱ ${minutes}:${remainder} — your move`;
  const timer = setTimeout(() => {
    if (document.title.startsWith("⏱ ")) document.title = original;
  }, 4_000);

  if (readSfx() && typeof AudioContext === "function") {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.value = 0.035;
    oscillator.frequency.value = 740;
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.08);
    oscillator.addEventListener("ended", () => void audio.close(), {
      once: true,
    });
  }
  return () => {
    clearTimeout(timer);
    if (document.title.startsWith("⏱ ")) document.title = original;
  };
}

function isWin(payload: SseEventMap["game_resolved"]): boolean {
  if (payload.result !== "white" && payload.result !== "black") return false;
  return payload.yourEntries.some((entry) => entry.side === payload.result);
}

type ResolutionEntry = SseEventMap["game_resolved"]["yourEntries"][number];
type StakedResolutionEntry = Extract<ResolutionEntry, { demo: false }>;

function resolutionNotice(payload: SseEventMap["game_resolved"]): {
  readonly text: string;
  readonly kind: "info" | "lose";
  readonly share:
    | { readonly gameId: string; readonly yourPly: number }
    | undefined;
} {
  const win = isWin(payload);
  const allDemo = payload.yourEntries.every((entry) => entry.demo);
  const stakedWin = payload.yourEntries.find(
    (entry): entry is StakedResolutionEntry =>
      !entry.demo && entry.side === payload.result,
  );
  const share =
    win && stakedWin !== undefined && payload.gameId !== undefined
      ? { gameId: payload.gameId, yourPly: stakedWin.ply }
      : undefined;

  if (allDemo) {
    return {
      text: "game resolved — nothing staked, nothing counted",
      kind: win ? "info" : "lose",
      share,
    };
  }
  if (win) {
    return {
      text: `✓ you won · ${formatMicroUsdc(payload.totalPayoutMicroUsdc)}`,
      kind: "info",
      share,
    };
  }
  if (payload.result === "draw" || payload.result === "aborted") {
    return {
      text: `game resolved · ${payload.result}`,
      kind: "lose",
      share,
    };
  }
  return { text: "✗ the game was lost", kind: "lose", share };
}

export function LiveProvider(props: {
  readonly client: ApiClient;
  readonly eventSourceFactory?: EventSourceFactory;
  readonly children: ReactNode;
}) {
  const { session } = useSession();
  const { meta, refetch, updateStatus } = useMeta();
  const { push } = useToasts();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  const profileRef = useRef<ProfileView | null>(null);
  const metaRef = useRef(meta);
  const eventSeq = useRef(0);
  const titleAlertCleanup = useRef<() => void>(() => undefined);
  const [connection, setConnection] = useState<SseConnectionState | "closed">(
    "closed",
  );
  const [currentClaim, setCurrentClaim] = useState<ClaimView | null>(null);
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [ongoing, setOngoing] = useState<GamesPage<OngoingGameItem> | null>(
    null,
  );
  const [finished, setFinished] = useState<GamesPage<FinishedGameItem> | null>(
    null,
  );
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const [gamesVersion, setGamesVersion] = useState(0);
  const [playPulse, setPlayPulse] = useState(0);
  const [playSurfaceVisible, setPlaySurfaceVisible] = useState(false);
  const [share, setShare] = useState<{
    readonly gameId: string;
    readonly yourPly: number;
  } | null>(null);
  const { client, eventSourceFactory } = props;
  const consumePlayNudge = useCallback(() => setPlayPulse(0), []);

  useEffect(() => {
    pathRef.current = location.pathname;
  }, [location.pathname]);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);

  const refreshGamesProfile = useCallback(() => {
    void client
      .getProfile()
      .then(setProfile)
      .catch(() => undefined);
    void client
      .getOngoingGames(1)
      .then(setOngoing)
      .catch(() => undefined);
    void client
      .getFinishedGames(1)
      .then(setFinished)
      .catch(() => undefined);
    setGamesVersion((version) => version + 1);
  }, [client]);

  const refreshAll = useCallback(() => {
    void client
      .getCurrentClaim()
      .then(setCurrentClaim)
      .catch(() => undefined);
    refreshGamesProfile();
    refetch();
  }, [client, refetch, refreshGamesProfile]);

  useEffect(() => {
    if (session.status !== "in") {
      setConnection("closed");
      setCurrentClaim(null);
      setProfile(null);
      setOngoing(null);
      setFinished(null);
      setPlaySurfaceVisible(false);
      return;
    }
    if (pathRef.current === "/") {
      refreshGamesProfile();
      refetch();
    } else {
      refreshAll();
    }
  }, [session.status, refreshAll, refreshGamesProfile, refetch]);

  useEffect(() => {
    if (session.status !== "in" || eventSourceFactory === undefined) return;
    const bus = new SseBus(eventSourceFactory);
    const unsubscribers: Array<() => void> = [];
    const record = <Type extends SseEventType>(
      type: Type,
      payload: SseEventMap[Type],
    ) => {
      eventSeq.current += 1;
      setLastEvent({ type, payload, seq: eventSeq.current } as LiveEvent);
    };
    const on = <Type extends SseEventType>(
      type: Type,
      handler: (payload: SseEventMap[Type]) => void,
    ) => {
      unsubscribers.push(
        bus.subscribe(type, (payload) => {
          record(type, payload);
          handler(payload);
        }),
      );
    };

    unsubscribers.push(
      bus.subscribeState((state) => {
        setConnection(state);
        if (state === "open") refetch();
      }),
    );
    on("claim_expiring", (payload) => {
      setCurrentClaim((claim) =>
        claim?.claimId === payload.claimId
          ? { ...claim, deadline: payload.deadline }
          : claim,
      );
      titleAlertCleanup.current();
      titleAlertCleanup.current = alertExpiring(payload.deadline);
    });
    on("claim_expired", (payload) => {
      setCurrentClaim((claim) =>
        claim?.claimId === payload.claimId ? null : claim,
      );
    });
    on("move_accepted", (payload) => {
      setCurrentClaim((claim) =>
        claim?.claimId === payload.claimId ? null : claim,
      );
      refreshGamesProfile();
    });
    on("game_available", () => {
      setPlayPulse((pulse) => pulse + 1);
      if (pathRef.current !== "/") {
        push("a board may be available — PLAY to check");
      }
    });
    on("game_resolved", (payload) => {
      const notice = resolutionNotice(payload);
      const share = notice.share;
      const action =
        share === undefined
          ? undefined
          : {
              label: "share ▸",
              onClick: () => setShare(share),
            };
      push(notice.text, notice.kind, action);
      refreshGamesProfile();
    });
    on("payout_confirmed", (payload) => {
      const currentMeta = metaRef.current;
      push(
        `payout confirmed · ${formatMicroUsdc(payload.amountMicroUsdc)}`,
        "info",
        currentMeta === null
          ? undefined
          : {
              label: "confirmed ↗",
              href: explorerTxUrl(
                currentMeta.network.explorerBaseUrl,
                payload.txid,
              ),
            },
      );
      refreshGamesProfile();
    });
    on("bonus_updated", refreshGamesProfile);
    on("system_banner", updateStatus);
    on("config_updated", refetch);
    on("stream_reset", refreshAll);

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      titleAlertCleanup.current();
      bus.close();
      setConnection("closed");
    };
  }, [
    session.status,
    eventSourceFactory,
    push,
    refetch,
    refreshAll,
    refreshGamesProfile,
    updateStatus,
  ]);

  const value = useMemo<LiveValue>(
    () => ({
      connection,
      currentClaim,
      profile,
      ongoing,
      finished,
      lastEvent,
      gamesVersion,
      playPulse,
      consumePlayNudge,
      playSurfaceVisible,
      setPlaySurfaceVisible,
      trackClaim: setCurrentClaim,
      refreshAll,
    }),
    [
      connection,
      currentClaim,
      profile,
      ongoing,
      finished,
      lastEvent,
      gamesVersion,
      playPulse,
      consumePlayNudge,
      playSurfaceVisible,
      refreshAll,
    ],
  );

  return (
    <LiveContext.Provider value={value}>
      <ShellLiveContext.Provider
        value={{ connection, currentClaim, playSurfaceVisible }}
      >
        {props.children}
        {share === null ? null : (
          <ShareSheet
            gameId={share.gameId}
            yourPly={share.yourPly}
            refCode={profileRef.current?.refCode ?? null}
            onClose={() => setShare(null)}
          />
        )}
      </ShellLiveContext.Provider>
    </LiveContext.Provider>
  );
}

export function useLive(): LiveValue {
  const value = useContext(LiveContext);
  if (value === null) throw new Error("useLive outside LiveProvider");
  return value;
}

export function useLiveOptional(): LiveValue | null {
  return useContext(LiveContext);
}
