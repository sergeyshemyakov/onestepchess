import { createChess, sideToMove } from "../chess/adapter.js";
import {
  type CoreConfig,
  coreConfigSchema,
  gameRulesSchema,
} from "../config.js";
import {
  canTransition,
  claimExpiryDue,
  type FsmEntity,
  gameStallDue,
  nextClaimDelaySeconds,
} from "../fsm/index.js";
import {
  checkDomainInvariants,
  type DomainSnapshot,
} from "../invariants/index.js";
import {
  type CandidateGame,
  eligibleGames,
  type Participation,
} from "../matchmaking/eligibility.js";
import { rollingWindowCheck } from "../matchmaking/quota.js";
import { pickGame } from "../matchmaking/ranking.js";
import { claimTerms } from "../matchmaking/terms.js";
import {
  type Resolution,
  type ResolveEntry,
  resolve,
} from "../payout/resolve.js";
import { createRng } from "../rng.js";
import type { GameResult, PlayerKind, Side, Termination } from "../types.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type GameRow = Mutable<DomainSnapshot["games"][number]>;
type ClaimRow = Mutable<DomainSnapshot["claims"][number]>;
type EntryRow = Mutable<DomainSnapshot["stakeEntries"][number]>;
type IntentRow = Mutable<DomainSnapshot["paymentIntents"][number]>;
type JobRow = Mutable<DomainSnapshot["payoutJobs"][number]>;

export type SimProfile = {
  readonly name: "P1" | "P2";
  readonly cfg: CoreConfig;
};

export const P1_PROFILE: SimProfile = {
  name: "P1",
  cfg: coreConfigSchema.parse({}),
};

/** Stress profile per spec §12: forces endspiel, adjudication, and cooldown
 * churn coverage. */
export const P2_PROFILE: SimProfile = {
  name: "P2",
  cfg: coreConfigSchema.parse({
    ENDSPIEL_PIECES: 20,
    MAX_PLIES: 60,
    COOLDOWN_PLIES: 2,
    CLAIM_TTL_HUMAN: 60,
    CLAIM_TTL_AGENT: 20,
    CLAIM_TTL_ENDSPIEL: 10,
  }),
};

/** Test-only rule-bug injection for the mutation spot-check. */
export type SimBug = "dropE4" | "cooldownOffByOne" | "skipHumanCap";

export type SimOptions = {
  readonly seed: number;
  readonly gameCount: number;
  readonly profile?: SimProfile;
  readonly bug?: SimBug;
};

export type SimReport = {
  readonly gamesCompleted: number;
  readonly terminations: Readonly<Record<Termination, number>>;
  readonly duplicateInjections: number;
  readonly ticks: number;
  readonly trace: readonly string[];
};

export class SimFailure extends Error {
  constructor(
    readonly seed: number,
    readonly step: number,
    readonly traceTail: readonly string[],
    detail: string,
  ) {
    super(`${detail} (seed=${seed} step=${step})\n${traceTail.join("\n")}`);
    this.name = "SimFailure";
  }
}

type Actor = {
  readonly id: string;
  readonly kind: PlayerKind;
  openClaimId: string | null;
  abandonIntent: boolean;
  readonly participation: Map<string, { side: Side; lastPly: number }>;
  readonly demoTimes: number[];
  readonly stakedTimes: number[];
  lifetimeClaims: number;
};

type LastMutation =
  | { kind: "claim"; claimId: string; gameId: string }
  | { kind: "ply"; claimId: string }
  | { kind: "expire"; claimId: string }
  | { kind: "resolve"; gameId: string }
  | { kind: "topup" };

function makeActors(): Actor[] {
  const actor = (id: string, kind: PlayerKind): Actor => ({
    id,
    kind,
    openClaimId: null,
    abandonIntent: false,
    participation: new Map(),
    demoTimes: [],
    stakedTimes: [],
    lifetimeClaims: 0,
  });
  return [
    ...Array.from({ length: 6 }, (_, i) => actor(`h${i + 1}`, "human")),
    ...Array.from({ length: 12 }, (_, i) => actor(`a${i + 1}`, "agent")),
    ...Array.from({ length: 3 }, (_, i) => actor(`u${i + 1}`, "guest")),
  ];
}

function floorDiv(numerator: number, denominator: number): number {
  return (numerator - (numerator % denominator)) / denominator;
}

/** Seeded, model-based domain simulator (spec §12): drives only core's pure
 * functions over an in-memory DomainSnapshot store with a fake clock,
 * asserting the shared invariant module after every mutation. Payments are
 * instant pure FSM bookkeeping. To keep 1,000 games inside the CI budget,
 * the per-mutation check runs on the touched game's snapshot slice (every
 * invariant except cross-game claim uniqueness is game-local); the full
 * store is checked every 50 ticks and each finished game gets a final
 * verifyFens pass before being archived out of the hot store. */
export function runSimulation(options: SimOptions): SimReport {
  const profile = options.profile ?? P1_PROFILE;
  const cfg = profile.cfg;
  const rules = gameRulesSchema.parse(cfg);
  const rng = createRng(options.seed);
  const chess = createChess(rules, { cacheSize: 8 * cfg.GAME_POOL_TARGET });
  const actors = makeActors();

  const games: GameRow[] = [];
  const claims: ClaimRow[] = [];
  const stakeEntries: EntryRow[] = [];
  const paymentIntents: IntentRow[] = [];
  const payoutJobs: JobRow[] = [];
  const gamesById = new Map<string, GameRow>();
  const claimsById = new Map<string, ClaimRow>();
  const claimsByGame = new Map<string, ClaimRow[]>();
  const entriesByGame = new Map<string, EntryRow[]>();
  const intentsByGame = new Map<string, IntentRow[]>();
  const jobsByGame = new Map<string, JobRow[]>();
  const openClaimByGame = new Map<string, string>();
  const recorded = new Map<
    string,
    { entries: ResolveEntry[]; result: GameResult; resolution: Resolution }
  >();

  let now = 1_700_000_000_000;
  let tick = 0;
  let gameSeq = 0;
  let claimSeq = 0;
  let entrySeq = 0;
  let intentSeq = 0;
  let duplicateInjections = 0;
  let gamesCompleted = 0;
  const terminations: Record<Termination, number> = {
    checkmate: 0,
    stalemate: 0,
    insufficient: 0,
    threefold: 0,
    fifty_move: 0,
    max_plies: 0,
    aborted: 0,
  };
  const trace: string[] = [];

  const fail = (detail: string): never => {
    throw new SimFailure(options.seed, tick, trace.slice(-25), detail);
  };

  const record = (line: string): void => {
    trace.push(`${tick} ${line}`);
  };

  const fullView = (): DomainSnapshot => ({
    cfg,
    games,
    claims,
    stakeEntries,
    paymentIntents,
    payoutJobs,
  });

  const gameView = (game: GameRow): DomainSnapshot => ({
    cfg,
    games: [game],
    claims: claimsByGame.get(game.id) ?? [],
    stakeEntries: entriesByGame.get(game.id) ?? [],
    paymentIntents: intentsByGame.get(game.id) ?? [],
    payoutJobs: jobsByGame.get(game.id) ?? [],
  });

  const assertClean = (snapshot: DomainSnapshot, verifyFens: boolean): void => {
    const violations = checkDomainInvariants(
      snapshot,
      verifyFens ? { verifyFens: true } : undefined,
    );
    if (violations.length > 0) {
      fail(
        `invariant violations: ${violations
          .map((v) => `${v.code} ${v.message} [${v.refs.join(",")}]`)
          .join("; ")}`,
      );
    }
  };

  const assertTransition = (
    entity: FsmEntity,
    from: string,
    to: string,
  ): void => {
    if (!canTransition(entity, from, to)) {
      fail(`illegal ${entity} transition ${from} -> ${to}`);
    }
  };

  const randomIndex = (length: number): number => (rng() * length) | 0;

  const toCandidate = (game: GameRow): CandidateGame => ({
    id: game.id,
    status: game.status as "active" | "endspiel",
    fen: game.fen,
    ply: game.ply,
    minNextClaimAt: game.minNextClaimAt,
    lastPlyAt: game.lastPlyAt,
    hasOpenClaim: openClaimByGame.has(game.id),
    cooldownPlies: game.rules.COOLDOWN_PLIES,
  });

  const indexRow = <T>(index: Map<string, T[]>, key: string, row: T): void => {
    const rows = index.get(key);
    if (rows === undefined) {
      index.set(key, [row]);
    } else {
      rows.push(row);
    }
  };

  const injectDuplicate = (mutation: LastMutation): void => {
    duplicateInjections += 1;
    switch (mutation.kind) {
      case "claim": {
        const game = gamesById.get(mutation.gameId);
        if (game !== undefined) {
          const candidate = toCandidate(game);
          const again = eligibleGames({
            games: [candidate],
            requesterKind: "human",
            participation: [],
            now,
          });
          if (candidate.hasOpenClaim && again.length > 0) {
            fail(`duplicate claim request for ${game.id} was not rejected`);
          }
        }
        record(`dup claim ${mutation.claimId}`);
        break;
      }
      case "ply": {
        const claim = claimsById.get(mutation.claimId);
        if (
          claim !== undefined &&
          canTransition("claim", claim.status, "moved")
        ) {
          fail(`duplicate ply delivery on ${claim.id} was not rejected`);
        }
        record(`dup ply ${mutation.claimId}`);
        break;
      }
      case "expire": {
        const claim = claimsById.get(mutation.claimId);
        if (
          claim !== undefined &&
          canTransition("claim", claim.status, "expired")
        ) {
          fail(`duplicate expiry on ${claim.id} was not rejected`);
        }
        record(`dup expire ${mutation.claimId}`);
        break;
      }
      case "resolve": {
        const saved = recorded.get(mutation.gameId);
        if (saved === undefined) {
          fail(`no recorded resolution for ${mutation.gameId}`);
          return;
        }
        const again = resolve(saved.entries, saved.result, rules);
        if (JSON.stringify(again) !== JSON.stringify(saved.resolution)) {
          fail(`re-running resolve() diverged for ${mutation.gameId}`);
        }
        const game = gamesById.get(mutation.gameId);
        if (
          game !== undefined &&
          canTransition("game", game.status, game.status)
        ) {
          fail(`duplicate terminal transition on ${game.id} was not rejected`);
        }
        record(`dup resolve ${mutation.gameId}`);
        break;
      }
      case "topup": {
        if (games.length > cfg.GAME_POOL_TARGET) {
          fail("duplicate pool top-up overfilled the pool");
        }
        record("dup topup");
        break;
      }
    }
  };

  const afterMutation = (
    mutation: LastMutation,
    game: GameRow | null,
  ): void => {
    if (game !== null) {
      assertClean(gameView(game), false);
    }
    if (rng() < 0.02) {
      injectDuplicate(mutation);
    }
  };

  const createGame = (): void => {
    gameSeq += 1;
    const initial = chess.initial();
    const row: GameRow = {
      id: `g${gameSeq}`,
      status: "active",
      fen: initial.fen,
      ply: 0,
      rules,
      history: initial.history,
      result: null,
      termination: null,
      endspielPly: null,
      minNextClaimAt: now,
      lastPlyAt: now,
      resolvedAt: null,
    };
    games.push(row);
    gamesById.set(row.id, row);
    record(`create ${row.id}`);
    afterMutation({ kind: "topup" }, row);
  };

  const ensurePool = (): void => {
    while (games.length < cfg.GAME_POOL_TARGET) {
      createGame();
    }
  };

  const releaseClaimHolder = (claim: ClaimRow): void => {
    const holder = actors.find((actor) => actor.id === claim.player);
    if (holder !== undefined && holder.openClaimId === claim.id) {
      holder.openClaimId = null;
      holder.abandonIntent = false;
    }
  };

  const expirySweep = (): void => {
    for (const [gameId, claimId] of [...openClaimByGame]) {
      const claim = claimsById.get(claimId);
      if (claim === undefined || claim.status !== "open") {
        fail(`open-claim index out of sync for ${gameId}`);
        return;
      }
      // Intents settle instantly in this model, so nothing is ever in flight
      // at the sweep point.
      if (claimExpiryDue(claim, false, now)) {
        assertTransition("claim", claim.status, "expired");
        claim.status = "expired";
        openClaimByGame.delete(gameId);
        releaseClaimHolder(claim);
        record(`expire ${claim.id}`);
        const game = gamesById.get(gameId);
        afterMutation({ kind: "expire", claimId: claim.id }, game ?? null);
      }
    }
    for (const claimId of openClaimByGame.values()) {
      const claim = claimsById.get(claimId);
      if (claim !== undefined && now >= claim.deadline) {
        fail(`liveness: open claim ${claim.id} survived past its deadline`);
      }
    }
  };

  const uncapHumanBonuses = (
    resolution: Resolution,
    entries: readonly ResolveEntry[],
  ): Resolution => {
    const scaledMult = rules.HUMAN_TARGET_MULT * 10_000;
    const multBps =
      scaledMult % 1 >= 0.5
        ? scaledMult - (scaledMult % 1) + 1
        : scaledMult - (scaledMult % 1);
    const targets = new Map<string, number>();
    for (const entry of entries) {
      if (entry.kind === "human") {
        targets.set(
          entry.entryId,
          floorDiv(entry.amountMicroUsdc * (multBps - 10_000), 10_000),
        );
      }
    }
    return {
      take: resolution.take,
      payouts: resolution.payouts.map((component) => {
        const target = targets.get(component.entryId);
        return component.tag === "bonus" && target !== undefined
          ? { ...component, amountMicroUsdc: target }
          : component;
      }),
    };
  };

  const resolveGame = (game: GameRow): void => {
    const gameEntries = entriesByGame.get(game.id) ?? [];
    const mapped: ResolveEntry[] = gameEntries.map((e) => ({
      entryId: e.id,
      player: e.player,
      side: e.side,
      kind: e.kind,
      amountMicroUsdc: e.amountMicroUsdc,
    }));
    const result = game.result as GameResult;
    const resolution = resolve(mapped, result, game.rules);
    const materialized =
      options.bug === "skipHumanCap"
        ? uncapHumanBonuses(resolution, mapped)
        : resolution;
    const byEntry = new Map<string, number>();
    const byRecipient = new Map<string, number>();
    for (const component of materialized.payouts) {
      byEntry.set(
        component.entryId,
        (byEntry.get(component.entryId) ?? 0) + component.amountMicroUsdc,
      );
      byRecipient.set(
        component.player,
        (byRecipient.get(component.player) ?? 0) + component.amountMicroUsdc,
      );
    }
    for (const entry of gameEntries) {
      entry.payoutMicroUsdc = byEntry.get(entry.id) ?? 0;
    }
    for (const [recipient, amount] of byRecipient) {
      if (amount <= 0) {
        continue;
      }
      const job: JobRow = {
        gameId: game.id,
        recipient,
        amountMicroUsdc: amount,
        reason:
          result === "white" || result === "black" ? "resolution" : "refund",
        status: "pending",
      };
      // Payments are modeled as instant pure bookkeeping: the payout job
      // walks its whole FSM chain within the resolution mutation.
      for (const next of ["prepared", "submitted", "confirmed"] as const) {
        assertTransition("payout", job.status, next);
        job.status = next;
      }
      payoutJobs.push(job);
      indexRow(jobsByGame, game.id, job);
    }
    game.resolvedAt = now;
    recorded.set(game.id, { entries: mapped, result, resolution });
    gamesCompleted += 1;
    terminations[game.termination as Termination] += 1;
  };

  const removeWhere = <T>(rows: T[], drop: (row: T) => boolean): void => {
    const kept = rows.filter((row) => !drop(row));
    rows.length = 0;
    for (const row of kept) {
      rows.push(row);
    }
  };

  const finalizeGame = (game: GameRow): void => {
    assertClean(gameView(game), true);
    const claimIds = new Set(
      (claimsByGame.get(game.id) ?? []).map((c) => c.id),
    );
    removeWhere(games, (g) => g.id === game.id);
    removeWhere(claims, (c) => c.gameId === game.id);
    removeWhere(stakeEntries, (e) => e.gameId === game.id);
    removeWhere(paymentIntents, (i) => claimIds.has(i.claimId));
    removeWhere(payoutJobs, (j) => j.gameId === game.id);
    gamesById.delete(game.id);
    claimsByGame.delete(game.id);
    entriesByGame.delete(game.id);
    intentsByGame.delete(game.id);
    jobsByGame.delete(game.id);
    for (const id of claimIds) {
      claimsById.delete(id);
    }
    openClaimByGame.delete(game.id);
    for (const actor of actors) {
      actor.participation.delete(game.id);
    }
  };

  const abortGame = (game: GameRow): void => {
    assertTransition("game", game.status, "aborted");
    game.status = "aborted";
    game.result = "aborted";
    game.termination = "aborted";
    resolveGame(game);
    record(`abort ${game.id}`);
    afterMutation({ kind: "resolve", gameId: game.id }, game);
    finalizeGame(game);
  };

  const stallSweep = (): void => {
    for (const game of [...games]) {
      if (gamesById.has(game.id) && gameStallDue(game, now, game.rules)) {
        abortGame(game);
      }
    }
  };

  /** Deliberately buggy eligibility used only for the mutation spot-check. */
  const buggyEligible = (
    candidates: readonly CandidateGame[],
    requesterKind: PlayerKind,
    participation: readonly Participation[],
  ): CandidateGame[] =>
    candidates.filter((game) => {
      if (
        game.status !== "active" &&
        !(game.status === "endspiel" && requesterKind === "agent")
      ) {
        return false;
      }
      if (game.hasOpenClaim || now < game.minNextClaimAt) {
        return false;
      }
      const played = participation.find((row) => row.gameId === game.id);
      if (played === undefined) {
        return true;
      }
      if (options.bug === "dropE4") {
        return game.ply - played.lastPly >= game.cooldownPlies;
      }
      return (
        sideToMove(game.fen) === played.side &&
        game.ply - played.lastPly >= game.cooldownPlies - 1
      );
    });

  const tryClaim = (actor: Actor): void => {
    if (
      actor.kind === "guest" &&
      actor.lifetimeClaims >= cfg.GUEST_CLAIM_ALLOWANCE
    ) {
      return;
    }
    const candidates = games.map(toCandidate);
    const participation: Participation[] = [
      ...actor.participation.entries(),
    ].map(([gameId, row]) => ({
      gameId,
      side: row.side,
      lastPly: row.lastPly,
    }));
    const trueEligible = eligibleGames({
      games: candidates,
      requesterKind: actor.kind,
      participation,
      now,
    });
    const eligible =
      options.bug === "dropE4" || options.bug === "cooldownOffByOne"
        ? buggyEligible(candidates, actor.kind, participation)
        : trueEligible;
    const pick = pickGame({ eligible, requesterKind: actor.kind, now, rng });
    if (pick === null) {
      return;
    }
    // The sim's own differential net: whatever was picked must satisfy the
    // real eligibility rules.
    if (!trueEligible.some((game) => game.id === pick.id)) {
      fail(`pick ${pick.id} for ${actor.id} violates the eligibility rules`);
    }
    const demo =
      actor.kind === "guest" ? true : actor.kind === "human" && rng() < 0.25;
    const quotaLimit = demo
      ? cfg.QUOTA_DEMO
      : actor.kind === "human"
        ? cfg.QUOTA_HUMAN
        : cfg.QUOTA_AGENT;
    const times = demo ? actor.demoTimes : actor.stakedTimes;
    const quota = rollingWindowCheck({
      eventTimestamps: times,
      limit: quotaLimit,
      windowSeconds: 3_600,
      now,
    });
    if (!quota.ok) {
      record(`quota ${actor.id} retry=${quota.retryAfterSeconds}`);
      return;
    }
    const game = gamesById.get(pick.id);
    if (game === undefined) {
      fail(`picked game ${pick.id} is not in the store`);
      return;
    }
    const terms = claimTerms({
      game: { fen: game.fen, status: game.status as "active" | "endspiel" },
      requesterKind: actor.kind,
      demo,
      now,
      cfg: game.rules,
    });
    claimSeq += 1;
    const claim: ClaimRow = {
      id: `c${claimSeq}`,
      gameId: game.id,
      player: actor.id,
      side: terms.side,
      demo,
      stakeMicroUsdc: terms.stakeMicroUsdc,
      status: "open",
      deadline: terms.deadline,
      movedPly: null,
    };
    claims.push(claim);
    claimsById.set(claim.id, claim);
    indexRow(claimsByGame, game.id, claim);
    openClaimByGame.set(game.id, claim.id);
    actor.openClaimId = claim.id;
    actor.abandonIntent = rng() < 0.08;
    actor.lifetimeClaims += 1;
    times.push(now);
    if (times.length > 400) {
      times.splice(0, times.length - 400);
    }
    record(`claim ${claim.id} ${game.id} ${actor.id}${demo ? " demo" : ""}`);
    afterMutation({ kind: "claim", claimId: claim.id, gameId: game.id }, game);
  };

  const playMove = (actor: Actor): void => {
    const claim = claimsById.get(actor.openClaimId ?? "");
    if (claim === undefined || claim.status !== "open") {
      actor.openClaimId = null;
      return;
    }
    if (now >= claim.deadline) {
      return;
    }
    const game = gamesById.get(claim.gameId);
    if (game === undefined) {
      fail(`open claim ${claim.id} points at an archived game`);
      return;
    }
    if (sideToMove(game.fen) !== claim.side) {
      fail(`claim ${claim.id} side diverged from the side to move`);
    }
    const state = { fen: game.fen, history: game.history };
    const legal = chess.legalMoves(state);
    const move = legal[randomIndex(legal.length)];
    if (move === undefined) {
      fail(`no legal moves on non-terminal game ${game.id}`);
      return;
    }

    const newPly = game.ply + 1;
    if (!claim.demo) {
      intentSeq += 1;
      const intent: IntentRow = {
        id: `i${intentSeq}`,
        claimId: claim.id,
        status: "verified",
        amountMicroUsdc: claim.stakeMicroUsdc,
      };
      for (const next of ["settling", "settled"] as const) {
        assertTransition("intent", intent.status, next);
        intent.status = next;
      }
      paymentIntents.push(intent);
      indexRow(intentsByGame, game.id, intent);
      entrySeq += 1;
      const entry: EntryRow = {
        id: `se${entrySeq}`,
        gameId: game.id,
        claimId: claim.id,
        player: actor.id,
        side: claim.side,
        kind: actor.kind === "agent" ? "agent" : "human",
        amountMicroUsdc: claim.stakeMicroUsdc,
        ply: newPly,
        payoutMicroUsdc: null,
      };
      stakeEntries.push(entry);
      indexRow(entriesByGame, game.id, entry);
    }
    assertTransition("claim", claim.status, "moved");
    claim.status = "moved";
    claim.movedPly = newPly;
    openClaimByGame.delete(game.id);
    actor.openClaimId = null;

    const nextState = chess.apply(state, move);
    game.fen = nextState.fen;
    game.history = nextState.history;
    game.ply = newPly;
    game.lastPlyAt = now;
    const phase = chess.phase(nextState);
    if (game.status === "active" && phase === "endspiel") {
      assertTransition("game", "active", "endspiel");
      game.status = "endspiel";
      game.endspielPly = newPly;
    }
    game.minNextClaimAt =
      now + nextClaimDelaySeconds(phase, game.rules) * 1_000;
    actor.participation.set(game.id, { side: claim.side, lastPly: newPly });
    record(`move ${game.id} ${move.uci} ${actor.id}`);

    const terminal = chess.terminal(nextState);
    if (terminal.over) {
      assertTransition("game", game.status, "finished");
      game.status = "finished";
      game.result = terminal.result;
      game.termination = terminal.termination;
      resolveGame(game);
      record(`finish ${game.id} ${terminal.termination}`);
      afterMutation({ kind: "resolve", gameId: game.id }, game);
      finalizeGame(game);
      return;
    }
    afterMutation({ kind: "ply", claimId: claim.id }, game);
  };

  const actorAct = (actor: Actor): void => {
    if (actor.openClaimId !== null) {
      if (!actor.abandonIntent && rng() < 0.75) {
        playMove(actor);
      }
      return;
    }
    if (rng() < 0.7) {
      tryClaim(actor);
    }
  };

  const tickOnce = (topUp: boolean): void => {
    tick += 1;
    now += (1 + randomIndex(30)) * 1_000;
    const stallProbability = options.bug === "skipHumanCap" ? 0.0005 : 0.005;
    if (games.length > 0 && rng() < stallProbability) {
      now += rules.STALL_ABORT_HOURS * 3_600_000 + 60_000;
      record("stall");
    }
    expirySweep();
    stallSweep();
    if (topUp) {
      ensurePool();
    }
    if (tick % 50 === 0) {
      assertClean(fullView(), false);
      const sampled = games[tick % games.length];
      if (sampled !== undefined) {
        assertClean(gameView(sampled), true);
      }
    }
    for (const actor of actors) {
      if (rng() < 0.75) {
        actorAct(actor);
      }
    }
  };

  const maxTicks = options.gameCount * 400 + 100_000;
  while (gamesCompleted < options.gameCount) {
    if (tick >= maxTicks) {
      fail("tick budget exhausted before reaching the requested game count");
    }
    tickOnce(true);
  }
  while (games.length > 0) {
    if (tick >= maxTicks + 100_000) {
      fail("liveness: started games did not reach terminal in the drain phase");
    }
    tickOnce(false);
  }

  return {
    gamesCompleted,
    terminations,
    duplicateInjections,
    ticks: tick,
    trace,
  };
}
