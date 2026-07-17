import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import type { ApiClient } from "./api/client.js";
import { SessionProvider, useSession } from "./auth/SessionContext.jsx";
import { AppShell } from "./components/AppShell.jsx";
import { ToastProvider, useToasts } from "./components/Toasts.jsx";
import { MetaProvider, useMeta } from "./meta/MetaContext.jsx";
import { Hub } from "./routes/Hub.jsx";
import { Landing } from "./routes/Landing.jsx";
import { NotFound } from "./routes/NotFound.jsx";

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

function BootSkeleton() {
  return (
    <AppShell>
      <p className="console" style={{ padding: "40px 22px" }}>
        &gt; connecting<span className="blink">▊</span>
      </p>
    </AppShell>
  );
}

/** `/` is one route: Landing without a session, Hub with one (§4.1). */
function Home(props: { readonly client: ApiClient }) {
  const { session, signedIn } = useSession();
  const { meta } = useMeta();

  if (meta === null || session.status === "probing") return <BootSkeleton />;
  if (session.status === "out") {
    return <Landing client={props.client} meta={meta} onSignedIn={signedIn} />;
  }
  return <Hub client={props.client} meta={meta} player={session.player} />;
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
            <Routes>
              <Route path="/" element={<Home client={props.client} />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </SessionProvider>
      </MetaProvider>
    </ToastProvider>
  );
}
