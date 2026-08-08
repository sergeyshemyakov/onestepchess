import { lazy, Suspense, useCallback, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router";
import type { ApiClient } from "./api/client.js";
import type { PlayerView } from "./api/schemas.js";
import type { EventSourceFactory } from "./api/sse.js";
import { SessionProvider, useSession } from "./auth/SessionContext.jsx";
import { BootSkeleton } from "./components/BootSkeleton.jsx";
import { ToastProvider, useToasts } from "./components/Toasts.jsx";
import { clearRef, writeGuestDemo } from "./lib/storage.js";
import { LiveProvider } from "./live/LiveContext.jsx";
import { MetaProvider, useMeta } from "./meta/MetaContext.jsx";

const Landing = lazy(() =>
  import("./routes/Landing.jsx").then((module) => ({
    default: module.Landing,
  })),
);
const Hub = lazy(() =>
  import("./routes/Hub.jsx").then((module) => ({ default: module.Hub })),
);
const Start = lazy(() =>
  import("./routes/Start.jsx").then((module) => ({ default: module.Start })),
);
const Rules = lazy(() =>
  import("./routes/Rules.jsx").then((module) => ({ default: module.Rules })),
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
const Admin = lazy(() =>
  import("./admin/AdminPage.jsx").then((module) => ({
    default: module.AdminRoute,
  })),
);
const NotFound = lazy(() =>
  import("./routes/NotFound.jsx").then((module) => ({
    default: module.NotFound,
  })),
);

export type AuthHandlers = { onUnauthorized: () => void };

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

function useSignedIn() {
  const { signedIn } = useSession();
  const { push } = useToasts();
  return useCallback(
    (player: PlayerView, linkedGuestClaims?: number) => {
      writeGuestDemo(null);
      clearRef();
      signedIn(player);
      if ((linkedGuestClaims ?? 0) > 0) {
        push(
          "your demo game is linked — the outcome will land in your finished pane",
        );
      }
    },
    [push, signedIn],
  );
}

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

function RulesRoute() {
  const { meta } = useMeta();
  if (meta === null) return <BootSkeleton />;
  return <Rules meta={meta} />;
}

function ArchiveRoute(props: { readonly client: ApiClient }) {
  const { session } = useSession();
  const { meta } = useMeta();
  if (meta === null || session.status === "probing") return <BootSkeleton />;
  if (session.status === "out") return <Navigate to="/" replace />;
  return <Archive client={props.client} meta={meta} player={session.player} />;
}

/** Route group that participates in meta/session boot. It is itself lazy so
 * a cold public replay does not download the authenticated application. */
export function ContextualApp(props: {
  readonly client: ApiClient;
  readonly authHandlers: AuthHandlers;
  readonly eventSourceFactory?: EventSourceFactory;
}) {
  return (
    <ToastProvider>
      <MetaProvider client={props.client}>
        <SessionProvider client={props.client}>
          <LiveProvider
            client={props.client}
            {...(props.eventSourceFactory === undefined
              ? {}
              : { eventSourceFactory: props.eventSourceFactory })}
          >
            <AuthBridge handlers={props.authHandlers} />
            <Suspense fallback={<BootSkeleton />}>
              <Routes>
                <Route path="/" element={<Home client={props.client} />} />
                <Route
                  path="/start"
                  element={<StartRoute client={props.client} />}
                />
                <Route path="/rules" element={<RulesRoute />} />
                <Route path="/championship" element={<Championship />} />
                <Route
                  path="/archive"
                  element={<ArchiveRoute client={props.client} />}
                />
                <Route path="/admin" element={<Admin />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </LiveProvider>
        </SessionProvider>
      </MetaProvider>
    </ToastProvider>
  );
}
