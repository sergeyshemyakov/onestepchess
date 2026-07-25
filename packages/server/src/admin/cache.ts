import { createHash } from "node:crypto";

type Entry<T> = {
  readonly value: T;
  readonly etag: string;
  readonly expiresAt: number;
};

export class AdminReadCache {
  private readonly entries = new Map<string, Entry<unknown>>();

  constructor(
    private readonly now: () => number,
    private readonly ttlSeconds: () => number,
  ) {}

  async get<T>(
    key: string,
    compute: () => T | Promise<T>,
  ): Promise<{ readonly value: T; readonly etag: string }> {
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached as Entry<T>;
    }
    const value = await compute();
    const etag = `"${createHash("sha256")
      .update(JSON.stringify(value))
      .digest("base64url")}"`;
    this.entries.set(key, {
      value,
      etag,
      expiresAt: this.now() + this.ttlSeconds() * 1_000,
    });
    return { value, etag };
  }

  invalidate(...prefixes: readonly string[]): void {
    for (const key of this.entries.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        this.entries.delete(key);
      }
    }
  }
}
