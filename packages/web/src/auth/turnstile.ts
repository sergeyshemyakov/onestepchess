// Lazy Turnstile loader (§4.8): the widget script is injected only when the
// registration modal opens — never on the landing or at boot. With no site
// key configured (dev/CI), the server verifier is a pass-through fixture and
// a fixture token is used without loading any script.

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export const DEV_FIXTURE_TOKEN = "dev-fixture-token";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

export function turnstileScriptRequested(): boolean {
  return scriptPromise !== null;
}

export function resetTurnstileForTests(): void {
  scriptPromise = null;
}

function loadScript(): Promise<TurnstileApi> {
  scriptPromise ??= new Promise((resolve, reject) => {
    if (window.turnstile !== undefined) {
      resolve(window.turnstile);
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.turnstile === undefined)
        reject(new Error("turnstile missing"));
      else resolve(window.turnstile);
    };
    script.onerror = () => reject(new Error("turnstile script failed"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Render the widget into `container` and resolve with a token. An empty
 * site key short-circuits to the dev fixture token with no script load. */
export async function obtainTurnstileToken(
  container: HTMLElement,
  siteKey: string,
): Promise<string> {
  if (siteKey === "") return DEV_FIXTURE_TOKEN;
  const api = await loadScript();
  return new Promise((resolve, reject) => {
    api.render(container, {
      sitekey: siteKey,
      callback: resolve,
      "error-callback": () => reject(new Error("turnstile failed")),
    });
  });
}
