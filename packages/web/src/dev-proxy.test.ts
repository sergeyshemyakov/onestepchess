import { describe, expect, it } from "vitest";
import { apiProxyTarget, devProxy, PROXIED_PATHS } from "./dev-proxy.js";

describe("web dev proxy (web spec §4.9)", () => {
  it("defaults the API proxy target to the local server", () => {
    expect(apiProxyTarget({})).toBe("http://localhost:3000");
  });

  it("honors VITE_API_PROXY when set", () => {
    expect(apiProxyTarget({ VITE_API_PROXY: "http://localhost:4444" })).toBe(
      "http://localhost:4444",
    );
  });

  it("proxies same-origin /api and /healthz to the server", () => {
    const proxy = devProxy({ VITE_API_PROXY: "http://localhost:3000" });
    expect(Object.keys(proxy).sort()).toEqual([...PROXIED_PATHS].sort());
    for (const path of PROXIED_PATHS) {
      expect(proxy[path]).toMatchObject({
        target: "http://localhost:3000",
        changeOrigin: true,
      });
    }
  });
});
