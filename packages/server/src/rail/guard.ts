import { type PaymentRail, RailError } from "@onestepchess/core";

export type RailDependencyName = "algod" | "indexer" | "facilitator";

export type RailDependencyState = {
  readonly open: boolean;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
};

export type GuardedRail = {
  /** Breaker-checked and capped to `maxConcurrent - reservedPriority`. */
  readonly rail: PaymentRail;
  /** For probes/recovery: reaches through an open breaker (it is the canary
   * that closes it) and may use the reserved capacity, but is still capped
   * and still observed. */
  readonly priorityRail: PaymentRail;
  state(): Record<RailDependencyName, RailDependencyState>;
};

const OPEN_AFTER_FAILURES = 3;
/** While open, non-priority callers are rejected outright; after this long
 * one trial call per cooldown window is admitted (half-open). */
const HALF_OPEN_COOLDOWN_MS = 30_000;
const DEFAULT_RESERVED_PRIORITY = 2;

/** Async PaymentRail methods classified by the upstream they reach. The
 * facilitator probe alone cannot stand in for algod health — the 2026-08-26
 * incident was an algod outage behind a healthy facilitator (F2). */
const METHOD_DEPENDENCY: Record<string, RailDependencyName> = {
  verify: "facilitator",
  settle: "facilitator",
  health: "facilitator",
  preparePayouts: "algod",
  prepareFunding: "algod",
  submitPrepared: "algod",
  getTransactionStatus: "algod",
  buildOptInTxn: "algod",
  submitSignedTransaction: "algod",
  buildSweepTxns: "algod",
  getBalances: "algod",
  getAccountInfo: "algod",
  findPayoutByNote: "indexer",
  findFundingByNote: "indexer",
};

/** In-band infrastructure failures per method: these resolve rather than
 * throw (health() → false; submit/verify/settle → { ok: false, reason:
 * "unavailable" }) but are upstream outages all the same and must trip the
 * breaker — during the 2026-08-26 outage every probe failure was in-band. */
const IN_BAND_FAILURE: Record<string, (result: unknown) => boolean> = {
  health: (result) => result === false,
  verify: unavailableResult,
  settle: unavailableResult,
  submitPrepared: unavailableResult,
  submitSignedTransaction: unavailableResult,
};

function unavailableResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === false &&
    (result as { reason?: unknown }).reason === "unavailable"
  );
}

type DependencyState = {
  consecutiveFailures: number;
  openedAt: number | null;
  lastTrialAt: number | null;
};

export type GuardedRailOptions = {
  readonly rail: PaymentRail;
  readonly now: () => number;
  readonly maxConcurrent: () => number;
  readonly reservedPriority?: number;
};

export function createGuardedRail(options: GuardedRailOptions): GuardedRail {
  const reserved = options.reservedPriority ?? DEFAULT_RESERVED_PRIORITY;
  const dependencies: Record<RailDependencyName, DependencyState> = {
    algod: { consecutiveFailures: 0, openedAt: null, lastTrialAt: null },
    indexer: { consecutiveFailures: 0, openedAt: null, lastTrialAt: null },
    facilitator: { consecutiveFailures: 0, openedAt: null, lastTrialAt: null },
  };
  let inFlight = 0;

  const admit = (dependency: DependencyState, priority: boolean): void => {
    if (dependency.openedAt !== null && !priority) {
      const now = options.now();
      const trialDue =
        now - dependency.openedAt >= HALF_OPEN_COOLDOWN_MS &&
        (dependency.lastTrialAt === null ||
          now - dependency.lastTrialAt >= HALF_OPEN_COOLDOWN_MS);
      if (!trialDue) {
        throw new RailError("UNAVAILABLE", "Rail dependency circuit open");
      }
      dependency.lastTrialAt = now;
    }
    const cap = priority
      ? options.maxConcurrent()
      : Math.max(1, options.maxConcurrent() - reserved);
    if (inFlight >= cap) {
      throw new RailError("UNAVAILABLE", "Rail call capacity exhausted");
    }
  };

  const observe = (dependency: DependencyState, failed: boolean): void => {
    if (!failed) {
      dependency.consecutiveFailures = 0;
      dependency.openedAt = null;
      dependency.lastTrialAt = null;
      return;
    }
    dependency.consecutiveFailures += 1;
    if (
      dependency.consecutiveFailures >= OPEN_AFTER_FAILURES &&
      dependency.openedAt === null
    ) {
      dependency.openedAt = options.now();
    }
  };

  const guardedCall = async (
    name: string,
    args: unknown[],
    priority: boolean,
  ): Promise<unknown> => {
    const dependencyName = METHOD_DEPENDENCY[name];
    if (dependencyName === undefined) {
      return (
        options.rail as unknown as Record<string, (...a: unknown[]) => unknown>
      )[name]?.(...args);
    }
    const dependency = dependencies[dependencyName];
    admit(dependency, priority);
    inFlight += 1;
    try {
      const result = await (
        options.rail as unknown as Record<
          string,
          (...a: unknown[]) => Promise<unknown>
        >
      )[name]?.(...args);
      observe(dependency, IN_BAND_FAILURE[name]?.(result) ?? false);
      return result;
    } catch (error) {
      // Contract/readiness errors are caller bugs or warm-up, not upstream
      // failures; only infrastructure unavailability trips the breaker. An
      // error that names the upstream that actually failed is attributed
      // there, not to the method's default dependency.
      const infra =
        !(error instanceof RailError) || error.code === "UNAVAILABLE";
      const attributed =
        error instanceof RailError && error.dependency !== undefined
          ? dependencies[error.dependency]
          : dependency;
      observe(attributed, infra);
      throw error;
    } finally {
      inFlight -= 1;
    }
  };

  // The proxy target must not be the rail itself: createAvmRail returns a
  // frozen object, and the get-trap invariant forces a frozen target's own
  // properties to be returned verbatim — wrapping them would throw TypeError
  // on every access (2026-08-27 outage).
  const wrap = (priority: boolean): PaymentRail =>
    new Proxy({} as PaymentRail, {
      get(_target, property) {
        if (
          typeof property === "string" &&
          METHOD_DEPENDENCY[property] !== undefined
        ) {
          return (...args: unknown[]) => guardedCall(property, args, priority);
        }
        return Reflect.get(options.rail, property);
      },
    });

  return {
    rail: wrap(false),
    priorityRail: wrap(true),
    state: () => ({
      algod: publicState(dependencies.algod),
      indexer: publicState(dependencies.indexer),
      facilitator: publicState(dependencies.facilitator),
    }),
  };
}

function publicState(dependency: DependencyState): RailDependencyState {
  return {
    open: dependency.openedAt !== null,
    consecutiveFailures: dependency.consecutiveFailures,
    openedAt: dependency.openedAt,
  };
}
