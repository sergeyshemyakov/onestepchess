import "@fontsource/vt323/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
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

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App client={client} authHandlers={authHandlers} />
    </StrictMode>,
  );
}
