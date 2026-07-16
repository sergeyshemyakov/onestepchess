import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/** One validated client-IP derivation for rate limits, Turnstile, and bonus
 * claim IPs (server spec §5): forwarding headers are honored only when
 * `TRUST_PROXY_HOPS` trusted ingress hops strip client-supplied ones. */
export function clientIp(c: Context, trustProxyHops: number): string {
  if (trustProxyHops > 0) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded !== undefined) {
      const parts = forwarded
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const index = parts.length - trustProxyHops;
      const candidate = parts[Math.max(0, index)];
      if (candidate !== undefined) {
        return candidate;
      }
    }
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
