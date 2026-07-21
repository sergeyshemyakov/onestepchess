import { writeRefFirstTouch } from "./storage.js";

// F-W13 ref capture: runs at app bootstrap on any route. A well-formed
// `?ref=` is stored (first touch wins) and stripped from the URL via
// history.replaceState — no reload, no router navigation. Malformed values
// are dropped silently (the URL is still cleaned — the param is ours).

// Ref codes are server-minted invite slugs (adjective-piece-NNN); the
// pattern is deliberately looser than the generator so a future slug shape
// doesn't silently break attribution.
const REF_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/i;

export function captureRefFromUrl(): void {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("ref");
  if (code === null) return;
  if (REF_PATTERN.test(code)) writeRefFirstTouch(code);
  url.searchParams.delete("ref");
  window.history.replaceState(window.history.state, "", url);
}
