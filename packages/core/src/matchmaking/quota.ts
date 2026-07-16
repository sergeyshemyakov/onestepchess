import type { EpochMs } from "../types.js";

export function rollingWindowCheck(args: {
  eventTimestamps: readonly EpochMs[];
  limit: number;
  windowSeconds: number;
  now: EpochMs;
}): { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number } {
  const { eventTimestamps, limit, windowSeconds, now } = args;
  const windowMs = windowSeconds * 1_000;
  const inWindow = eventTimestamps
    .filter((ts) => ts > now - windowMs)
    .sort((left, right) => left - right);
  if (inWindow.length < limit) {
    return { ok: true, remaining: limit - inWindow.length };
  }
  // The slot frees when the oldest still-counting event ages out of the window.
  const freeing = inWindow[inWindow.length - limit] ?? now;
  const waitMs = freeing + windowMs - now;
  const ceilSeconds = (waitMs + 999 - ((waitMs + 999) % 1_000)) / 1_000;
  return { ok: false, retryAfterSeconds: ceilSeconds };
}
