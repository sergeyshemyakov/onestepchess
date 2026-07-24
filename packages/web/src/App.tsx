import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import type { ApiClient } from "./api/client.js";
import type { EventSourceFactory } from "./api/sse.js";
import type { AuthHandlers } from "./ContextualApp.jsx";
import { BootSkeleton } from "./components/BootSkeleton.jsx";
import { captureRefFromUrl } from "./lib/refCapture.js";

const ContextualApp = lazy(() =>
  import("./ContextualApp.jsx").then((module) => ({
    default: module.ContextualApp,
  })),
);
const Replay = lazy(() =>
  import("./routes/Replay.jsx").then((module) => ({ default: module.Replay })),
);

export type { AuthHandlers } from "./ContextualApp.jsx";

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

export function App(props: {
  readonly client: ApiClient;
  readonly authHandlers: AuthHandlers;
  readonly eventSourceFactory?: EventSourceFactory;
}) {
  return (
    <BrowserRouter>
      <RefCapture />
      <Routes>
        <Route
          path="/replay/:gameId"
          element={
            <Suspense fallback={<BootSkeleton showSystemBanner={false} />}>
              <Replay client={props.client} />
            </Suspense>
          }
        />
        <Route
          path="*"
          element={
            <Suspense fallback={<BootSkeleton showSystemBanner={false} />}>
              <ContextualApp
                client={props.client}
                authHandlers={props.authHandlers}
                {...(props.eventSourceFactory === undefined
                  ? {}
                  : { eventSourceFactory: props.eventSourceFactory })}
              />
            </Suspense>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
