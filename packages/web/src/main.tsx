import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/components.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, type AuthHandlers } from "./App.jsx";
import { createApiClient } from "./api/client.js";
import { readTheme } from "./lib/storage.js";

document.documentElement.dataset.theme = readTheme();

const authHandlers: AuthHandlers = { onUnauthorized: () => undefined };
const client = createApiClient({
  onUnauthorized: () => authHandlers.onUnauthorized(),
});
const eventSourceFactory = (url: string) => new EventSource(url);

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App
        client={client}
        authHandlers={authHandlers}
        eventSourceFactory={eventSourceFactory}
      />
    </StrictMode>,
  );
}
