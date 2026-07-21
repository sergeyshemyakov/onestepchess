import sharp from "sharp";

// In-process LRU of rasterized share cards (server spec F16 step 1). Bounded by
// CARD_CACHE_MAX; a card is a snapshot, so serving a slightly stale PNG under a
// live nickname is accepted. Map insertion order is the LRU order — a hit is
// re-inserted at the end, and eviction drops the oldest key.

export class CardCache {
  private readonly cache = new Map<string, Buffer>();

  constructor(private readonly max: number) {}

  async render(key: string, svg: string): Promise<Buffer> {
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    this.cache.set(key, png);
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return png;
  }

  get size(): number {
    return this.cache.size;
  }
}
