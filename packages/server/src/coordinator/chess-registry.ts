import { type ChessGame, createChess } from "@onestepchess/core";

export type ChessThresholds = {
  readonly ENDSPIEL_PIECES: number;
  readonly REPETITION_WIN_MARGIN: number;
  readonly MAX_PLIES: number;
};

/** Adapters keyed by the chess-threshold fields of `rules_json`
 * (server spec §7): config edits affect new games without touching live
 * ones; entries fall out of the LRU after their last game leaves the
 * working set. */
export class ChessAdapterRegistry {
  private readonly adapters = new Map<string, ChessGame>();
  private readonly historyCacheSize: number;

  constructor(
    private readonly capacity: number,
    options: { readonly historyCacheSize?: number } = {},
  ) {
    this.historyCacheSize = options.historyCacheSize ?? 64;
  }

  get(rules: ChessThresholds): ChessGame {
    const key = `${rules.ENDSPIEL_PIECES}:${rules.REPETITION_WIN_MARGIN}:${rules.MAX_PLIES}`;
    const cached = this.adapters.get(key);
    if (cached !== undefined) {
      this.adapters.delete(key);
      this.adapters.set(key, cached);
      return cached;
    }
    const adapter = createChess(
      {
        ENDSPIEL_PIECES: rules.ENDSPIEL_PIECES,
        REPETITION_WIN_MARGIN: rules.REPETITION_WIN_MARGIN,
        MAX_PLIES: rules.MAX_PLIES,
      },
      { cacheSize: this.historyCacheSize },
    );
    this.adapters.set(key, adapter);
    while (this.adapters.size > this.capacity) {
      const oldest = this.adapters.keys().next().value;
      if (oldest === undefined) break;
      this.adapters.delete(oldest);
    }
    return adapter;
  }
}
