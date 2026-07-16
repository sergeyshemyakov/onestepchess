// Dev-only Vite proxy: the SPA and API share one origin in production, so in
// development Vite forwards the same-origin API + health surfaces to the local
// server (web spec §4.9). Imported by vite.config.ts; never shipped to the
// browser bundle.

// Minimal local typing so this module needs no @types/node under the web
// tsconfig (which types only vite/client + DOM).
declare const process: { readonly env: Record<string, string | undefined> };

export const PROXIED_PATHS = ["/api", "/healthz"] as const;

export function apiProxyTarget(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.VITE_API_PROXY ?? "http://localhost:3000";
}

export function devProxy(
  env: Record<string, string | undefined> = process.env,
): Record<string, { readonly target: string; readonly changeOrigin: true }> {
  const target = apiProxyTarget(env);
  return Object.fromEntries(
    PROXIED_PATHS.map((path) => [path, { target, changeOrigin: true }]),
  );
}
