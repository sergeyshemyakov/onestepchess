import { describe, expect, it } from "vitest";
import { createChess } from "../chess/adapter.js";
import { coreConfigSchema, gameRulesSchema } from "../config.js";
import { checkDomainInvariants as barrelCheck } from "../index.js";
import type { Uci } from "../types.js";
import {
  checkDomainInvariants,
  type DomainSnapshot,
  type InvariantViolation,
} from "./index.js";

const cfg = coreConfigSchema.parse({});
const rules = gameRulesSchema.parse({});
const chess = createChess(rules);

const NOW = 1_700_000_000_000;

function fenAfter(history: readonly Uci[]): string {
  return chess.fromHistory(history).fen;
}

const ACTIVE_HISTORY: readonly Uci[] = ["e2e4", "e7e5"];
const MATE_HISTORY: readonly Uci[] = ["f2f3", "e7e5", "g2g4", "d8h4"];

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer E)[] ? E[] : T[K];
};

function cleanSnapshot(): Mutable<DomainSnapshot> & {
  games: Mutable<DomainSnapshot["games"][number]>[];
  claims: Mutable<DomainSnapshot["claims"][number]>[];
  stakeEntries: Mutable<DomainSnapshot["stakeEntries"][number]>[];
  paymentIntents: Mutable<DomainSnapshot["paymentIntents"][number]>[];
  payoutJobs: Mutable<DomainSnapshot["payoutJobs"][number]>[];
} {
  return {
    cfg,
    games: [
      {
        id: "g1",
        status: "active",
        fen: fenAfter(ACTIVE_HISTORY),
        ply: 2,
        rules,
        history: [...ACTIVE_HISTORY],
        result: null,
        termination: null,
        endspielPly: null,
        minNextClaimAt: NOW,
        lastPlyAt: NOW - 30_000,
        resolvedAt: null,
      },
      {
        id: "g2",
        status: "finished",
        fen: fenAfter(MATE_HISTORY),
        ply: 4,
        rules,
        history: [...MATE_HISTORY],
        result: "black",
        termination: "checkmate",
        endspielPly: null,
        minNextClaimAt: NOW,
        lastPlyAt: NOW - 10_000,
        resolvedAt: NOW - 5_000,
      },
    ],
    claims: [
      {
        id: "c1",
        gameId: "g1",
        player: "alice",
        side: "white",
        demo: false,
        stakeMicroUsdc: 10_000,
        status: "moved",
        deadline: NOW - 60_000,
        movedPly: 1,
      },
      {
        id: "c2",
        gameId: "g1",
        player: "bob",
        side: "black",
        demo: false,
        stakeMicroUsdc: 10_000,
        status: "moved",
        deadline: NOW - 40_000,
        movedPly: 2,
      },
      {
        id: "c3",
        gameId: "g1",
        player: "carol",
        side: "white",
        demo: true,
        stakeMicroUsdc: 0,
        status: "open",
        deadline: NOW + 600_000,
        movedPly: null,
      },
      {
        id: "c4",
        gameId: "g2",
        player: "dave",
        side: "white",
        demo: false,
        stakeMicroUsdc: 10_000,
        status: "moved",
        deadline: NOW - 90_000,
        movedPly: 1,
      },
      {
        id: "c5",
        gameId: "g2",
        player: "erin",
        side: "black",
        demo: false,
        stakeMicroUsdc: 1_000,
        status: "moved",
        deadline: NOW - 80_000,
        movedPly: 2,
      },
    ],
    stakeEntries: [
      {
        id: "se1",
        gameId: "g1",
        claimId: "c1",
        player: "alice",
        side: "white",
        kind: "human",
        amountMicroUsdc: 10_000,
        ply: 1,
        payoutMicroUsdc: null,
      },
      {
        id: "se2",
        gameId: "g1",
        claimId: "c2",
        player: "bob",
        side: "black",
        kind: "human",
        amountMicroUsdc: 10_000,
        ply: 2,
        payoutMicroUsdc: null,
      },
      {
        id: "se3",
        gameId: "g2",
        claimId: "c4",
        player: "dave",
        side: "white",
        kind: "human",
        amountMicroUsdc: 10_000,
        ply: 1,
        payoutMicroUsdc: 0,
      },
      {
        id: "se4",
        gameId: "g2",
        claimId: "c5",
        player: "erin",
        side: "black",
        kind: "agent",
        amountMicroUsdc: 1_000,
        ply: 2,
        payoutMicroUsdc: 11_000,
      },
    ],
    paymentIntents: [
      { id: "i1", claimId: "c1", status: "settled", amountMicroUsdc: 10_000 },
      { id: "i2", claimId: "c2", status: "settled", amountMicroUsdc: 10_000 },
      { id: "i3", claimId: "c4", status: "settled", amountMicroUsdc: 10_000 },
      { id: "i4", claimId: "c5", status: "settled", amountMicroUsdc: 1_000 },
    ],
    payoutJobs: [
      {
        gameId: "g2",
        recipient: "erin",
        amountMicroUsdc: 11_000,
        reason: "resolution",
        status: "confirmed",
      },
    ],
  };
}

function codesOf(violations: readonly InvariantViolation[]): string[] {
  return [...new Set(violations.map((v) => v.code))];
}

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`missing fixture row ${index}`);
  }
  return item;
}

describe("checkDomainInvariants", () => {
  it("passes a clean snapshot with and without verifyFens", () => {
    expect(checkDomainInvariants(cleanSnapshot())).toEqual([]);
    expect(
      checkDomainInvariants(cleanSnapshot(), { verifyFens: true }),
    ).toEqual([]);
  });

  it("K1: catches a second open claim per game and per player", () => {
    const perGame = cleanSnapshot();
    perGame.claims.push({
      ...pick(perGame.claims, 2),
      id: "c6",
      player: "mallory",
    });
    const perGameViolations = checkDomainInvariants(perGame);
    expect(codesOf(perGameViolations)).toEqual(["K1"]);
    expect(perGameViolations[0]?.refs).toContain("g1");

    const perPlayer = cleanSnapshot();
    perPlayer.games.push({
      ...pick(perPlayer.games, 0),
      id: "g3",
      history: [...ACTIVE_HISTORY],
    });
    perPlayer.claims.push({
      ...pick(perPlayer.claims, 2),
      id: "c6",
      gameId: "g3",
    });
    const perPlayerViolations = checkDomainInvariants(perPlayer);
    expect(codesOf(perPlayerViolations)).toEqual(["K1"]);
    expect(perPlayerViolations.some((v) => v.refs.includes("carol"))).toBe(
      true,
    );
  });

  it("K2: catches a stake entry on the opposite side of a moved claim", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.stakeEntries, 1).side = "white";
    const violations = checkDomainInvariants(snapshot);
    expect(codesOf(violations)).toEqual(["K2"]);
    expect(violations[0]?.refs).toContain("bob");
  });

  it("K3: catches a settled intent on a non-moved claim", () => {
    const snapshot = cleanSnapshot();
    snapshot.paymentIntents.push({
      id: "i5",
      claimId: "c3",
      status: "settled",
      amountMicroUsdc: 0,
    });
    const violations = checkDomainInvariants(snapshot);
    expect(codesOf(violations)).toEqual(["K3"]);
    expect(violations[0]?.refs).toContain("i5");
  });

  it("K3: catches a moved non-demo claim without exactly one settled intent", () => {
    const snapshot = cleanSnapshot();
    snapshot.paymentIntents = snapshot.paymentIntents.filter(
      (intent) => intent.id !== "i2",
    );
    const violations = checkDomainInvariants(snapshot);
    expect(codesOf(violations)).toEqual(["K3"]);
    expect(violations[0]?.refs).toContain("c2");
  });

  it("K3: catches two in-flight intents on one claim", () => {
    const snapshot = cleanSnapshot();
    snapshot.paymentIntents.push(
      { id: "i5", claimId: "c3", status: "verified", amountMicroUsdc: 0 },
      { id: "i6", claimId: "c3", status: "settling", amountMicroUsdc: 0 },
    );
    const violations = checkDomainInvariants(snapshot);
    expect(codesOf(violations)).toEqual(["K3"]);
    expect(violations[0]?.refs).toContain("c3");
  });

  it("K4: catches a tampered job amount", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.payoutJobs, 0).amountMicroUsdc = 11_001;
    const violations = checkDomainInvariants(snapshot);
    expect(codesOf(violations)).toEqual(["K4"]);
    expect(violations[0]?.refs).toContain("g2");
  });

  it("K4: catches a tampered job recipient", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.payoutJobs, 0).recipient = "mallory";
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K4"]);
  });

  it("K4: catches an extra job", () => {
    const snapshot = cleanSnapshot();
    snapshot.payoutJobs.push({
      gameId: "g2",
      recipient: "dave",
      amountMicroUsdc: 1,
      reason: "resolution",
      status: "pending",
    });
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K4"]);
  });

  it("K4: catches a missing job", () => {
    const snapshot = cleanSnapshot();
    snapshot.payoutJobs = [];
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K4"]);
  });

  it("K4: catches a tampered materialized entry payout", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.stakeEntries, 3).payoutMicroUsdc = 10_999;
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K4"]);
  });

  it("K4: catches a missing explicit zero payout", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.stakeEntries, 2).payoutMicroUsdc = null;
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K4"]);
  });

  it("K4: allows an unresolved terminal game with neither payouts nor jobs", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.games, 1).resolvedAt = null;
    pick(snapshot.stakeEntries, 2).payoutMicroUsdc = null;
    pick(snapshot.stakeEntries, 3).payoutMicroUsdc = null;
    snapshot.payoutJobs = [];
    expect(checkDomainInvariants(snapshot)).toEqual([]);
  });

  it("K5: catches a terminal game without result or termination", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.games, 1).result = null;
    const violations = checkDomainInvariants(snapshot);
    expect(codesOf(violations)).toContain("K5");
  });

  it("K5: catches aborted status with a non-aborted result", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.games, 1).status = "aborted";
    expect(codesOf(checkDomainInvariants(snapshot))).toContain("K5");
  });

  it("K5: catches a non-terminal game with a result", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.games, 0).result = "draw";
    pick(snapshot.games, 0).termination = "stalemate";
    expect(codesOf(checkDomainInvariants(snapshot))).toContain("K5");
  });

  it("K6: catches an active game with endspielPly set", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.games, 0).endspielPly = 1;
    const violations = checkDomainInvariants(snapshot);
    expect(codesOf(violations)).toEqual(["K6"]);
    expect(violations[0]?.refs).toContain("g1");
  });

  it("K6: catches an endspiel game with endspielPly above ply", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.games, 0).status = "endspiel";
    pick(snapshot.games, 0).endspielPly = 3;
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K6"]);
  });

  it("K7: catches a moved claim without movedPly", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.claims, 0).movedPly = null;
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K7"]);
  });

  it("K7: catches an open claim on a terminal game", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.claims, 2).gameId = "g2";
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K7"]);
  });

  it("K7: catches demo/stake inconsistency in both directions", () => {
    const demoWithStake = cleanSnapshot();
    pick(demoWithStake.claims, 2).stakeMicroUsdc = 500;
    expect(codesOf(checkDomainInvariants(demoWithStake))).toEqual(["K7"]);

    const freeNonDemo = cleanSnapshot();
    pick(freeNonDemo.claims, 2).demo = false;
    expect(codesOf(checkDomainInvariants(freeNonDemo))).toEqual(["K7"]);
  });

  it("K8: catches a stake entry whose parent claim is not moved or demo", () => {
    const snapshot = cleanSnapshot();
    snapshot.stakeEntries.push({
      id: "se5",
      gameId: "g1",
      claimId: "c3",
      player: "carol",
      side: "white",
      kind: "human",
      amountMicroUsdc: 0,
      ply: 2,
      payoutMicroUsdc: null,
    });
    const violations = checkDomainInvariants(snapshot);
    expect(codesOf(violations)).toEqual(["K8"]);
    expect(violations.some((v) => v.refs.includes("se5"))).toBe(true);
  });

  it("K8: catches an entry ply above the game ply", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.stakeEntries, 0).ply = 3;
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K8"]);
  });

  it("K8: catches an entry amount that differs from the claim stake", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.stakeEntries, 0).amountMicroUsdc = 9_999;
    expect(codesOf(checkDomainInvariants(snapshot))).toEqual(["K8"]);
  });

  it("K9: verifyFens catches a single corrupted history entry", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.games, 0).history = ["e2e4", "e7e6"];
    expect(checkDomainInvariants(snapshot)).toEqual([]);
    const violations = checkDomainInvariants(snapshot, { verifyFens: true });
    expect(codesOf(violations)).toEqual(["K9"]);
    expect(violations[0]?.refs).toContain("g1");
  });

  it("K9: verifyFens catches an unreplayable history", () => {
    const snapshot = cleanSnapshot();
    pick(snapshot.games, 0).history = ["e2e4", "e2e4"];
    const violations = checkDomainInvariants(snapshot, { verifyFens: true });
    expect(codesOf(violations)).toEqual(["K9"]);
  });

  it("exports through the core barrel", () => {
    expect(barrelCheck).toBe(checkDomainInvariants);
  });
});
