export type RateDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSeconds: number };

export type RateLimiter = {
  take(key: string): RateDecision;
};

/** In-memory per-key token bucket (server spec §6.1): capacity = the
 * per-minute limit, refilled continuously. The limit is read per call so an
 * admin config edit applies to subsequent requests. */
export function createTokenBucket(options: {
  readonly limitPerMinute: () => number;
  readonly now: () => number;
}): RateLimiter {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  return {
    take(key) {
      const limit = options.limitPerMinute();
      const ratePerMs = limit / 60_000;
      const now = options.now();
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { tokens: limit, updatedAt: now };
        buckets.set(key, bucket);
      } else {
        bucket.tokens = Math.min(
          limit,
          bucket.tokens + (now - bucket.updatedAt) * ratePerMs,
        );
        bucket.updatedAt = now;
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { ok: true };
      }
      return {
        ok: false,
        retryAfterSeconds: Math.ceil((1 - bucket.tokens) / ratePerMs / 1_000),
      };
    },
  };
}
