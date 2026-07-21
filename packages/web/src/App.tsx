import { lazy, Suspense, useEffect } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";
import type { ApiClient } from "./api/client.js";
import type { PlayerView } from "./api/schemas.js";
import { SessionProvider, useSession } from "./auth/SessionContext.jsx";
import { AppShell } from "./components/AppShell.jsx";
import { ToastProvider, useToasts } from "./components/Toasts.jsx";
import { captureRefFromUrl } from "./lib/refCapture.js";
import { clearRef, writeGuestDemo } from "./lib/storage.js";
import { MetaProvider, useMeta } from "./meta/MetaContext.jsx";
import { Hub } from "./routes/Hub.jsx";
import { Landing } from "./routes/Landing.jsx";
import { NotFound } from "./routes/NotFound.jsx";

// §9: every route is a lazy chunk — `/replay` is a cold-entry page via
// shared links and must load only itself.
const Start = lazy(() =>
  import("./routes/Start.jsx").then((module) => ({ default: module.Start })),
);
const Championship = lazy(() =>
  import("./routes/Championship.jsx").then((module) => ({
    default: module.Championship,
  })),
);
const Archive = lazy(() =>
  import("./routes/Archive.jsx").then((module) => ({
    default: module.Archive,
  })),
);
const Replay = lazy(() =>
  import("./routes/Replay.jsx").then((module) => ({ default: module.Replay })),
);

export type AuthHandlers = { onUnauthorized: () => void };

/** 401 anywhere mid-session lands on the landing with a quiet toast (§5.2). */
function AuthBridge(props: { readonly handlers: AuthHandlers }) {
  const { droppedByServer } = useSession();
  const { push } = useToasts();
  useEffect(() => {
    props.handlers.onUnauthorized = () => {
      droppedByServer();
      push("signed out");
    };
    return () => {
      props.handlers.onUnauthorized = () => undefined;
    };
  }, [props.handlers, droppedByServer, push]);
  return null;
}

/** F-W13 first-touch `?ref=` capture on any route, URL cleaned without a
 * reload. Runs again on in-app navigation — capture stays idempotent. */
function RefCapture() {
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies(location): re-runs on every navigation by design — ?ref= can arrive on any route
  useEffect(() => {
    captureRefFromUrl();
  }, [location]);
  return null;
}

function BootSkeleton() {
  return (
    <AppShell>
      <p className="console" style={{ padding: "40px 22px" }}>
        &gt; connecting<span className="blink">▊</span>
      </p>
    </AppShell>
  );
}

/** Shared sign-in bookkeeping (§5.2): guest flag + ref clear + linked-demo
 * toast, used by every surface that can complete a verify. */
function useSignedIn() {
  const { signedIn } = useSession();
  const { push } = useToasts();
  return (player: PlayerView, linkedGuestClaims?: number) => {
    writeGuestDemo(null);
    clearRef();
    signedIn(player);
    if ((linkedGuestClaims ?? 0) > 0) {
      push(
        "your demo game is linked — the outcome will land in your finished pane",
      );
    }
  };
}

/** `/` is one route: Landing without a session, Hub with one (§4.1). */
function Home(props: { readonly client: ApiClient }) {
  const { session } = useSession();
  const { meta } = useMeta();
  const onSignedIn = useSignedIn();

  if (meta === null || session.status === "probing") return <BootSkeleton />;
  if (session.status === "out") {
    return (
      <Landing client={props.client} meta={meta} onSignedIn={onSignedIn} />
    );
  }
  return <Hub client={props.client} meta={meta} player={session.player} />;
}

function StartRoute(props: { readonly client: ApiClient }) {
  const { meta } = useMeta();
  const onSignedIn = useSignedIn();
  if (meta === null) return <BootSkeleton />;
  return <Start client={props.client} meta={meta} onSignedIn={onSignedIn} />;
}

/** `/archive` needs a session — no session redirects to `/` (§4.1). */
function ArchiveRoute(props: { readonly client: ApiClient }) {
  const { session } = useSession();
  const { meta } = useMeta();
  if (meta === null || session.status === "probing") return <BootSkeleton />;
  if (session.status === "out") return <Navigate to="/" replace />;
  return <Archive client={props.client} meta={meta} />;
}

export function App(props: {
  readonly client: ApiClient;
  readonly authHandlers: AuthHandlers;
}) {
  return (
    <ToastProvider>
      <MetaProvider client={props.client}>
        <SessionProvider client={props.client}>
          <AuthBridge handlers={props.authHandlers} />
          <BrowserRouter>
            <RefCapture />
            <Suspense fallback={<BootSkeleton />}>
              <Routes>
                <Route path="/" element={<Home client={props.client} />} />
                <Route
                  path="/start"
                  element={<StartRoute client={props.client} />}
                />
                <Route path="/championship" element={<Championship />} />
                <Route
                  path="/archive"
                  element={<ArchiveRoute client={props.client} />}
                />
                <Route
                  path="/replay/:gameId"
                  element={<Replay client={props.client} />}
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </SessionProvider>
      </MetaProvider>
    </ToastProvider>
  );
}
