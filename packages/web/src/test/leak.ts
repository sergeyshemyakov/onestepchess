// I7 leak-test helper (§11): asserts no game identity reaches a rendered
// DOM — used by every pre-terminal surface test from W1 on.

export class GameIdentityLeak extends Error {
  constructor(readonly leaked: string) {
    super(`game identity leaked into the DOM: ${leaked}`);
    this.name = "GameIdentityLeak";
  }
}

/** Throw when any seeded identity string (game id, name, ply, history…)
 * appears anywhere in the container's markup — text or attributes. */
export function assertNoGameIdentity(
  container: HTMLElement,
  seeds: readonly string[],
): void {
  const html = container.innerHTML;
  for (const seed of seeds) {
    if (seed.length > 0 && html.includes(seed)) {
      throw new GameIdentityLeak(seed);
    }
  }
}
