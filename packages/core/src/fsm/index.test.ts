import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { gameRulesSchema } from "../config.js";
import {
  canTransition,
  claimExpiryDue,
  FSM,
  type FsmEntity,
  gameStallDue,
  nextClaimDelaySeconds,
} from "./index.js";

const RULES = gameRulesSchema.parse({});
const STATES = {
  game: ["active", "endspiel", "finished", "aborted"],
  claim: ["open", "moved", "expired"],
  intent: ["verified", "settling", "settled", "failed"],
  payout: ["pending", "prepared", "submitted", "confirmed", "failed"],
} as const satisfies Readonly<Record<FsmEntity, readonly string[]>>;

describe("FSM transition legality", () => {
  it.each(
    Object.keys(STATES) as FsmEntity[],
  )("asserts the exhaustive %s from-by-to matrix against the pinned table", (entity) => {
    const table = FSM[entity] as Readonly<Record<string, readonly string[]>>;
    for (const from of STATES[entity]) {
      for (const to of STATES[entity]) {
        expect(
          canTransition(entity, from, to),
          `${entity}: ${from} -> ${to}`,
        ).toBe(table[from]?.includes(to) ?? false);
      }
    }
    expect(
      canTransition(entity, "unknown", STATES[entity][0] ?? "unknown"),
    ).toBe(false);
  });

  it("accepts only random transition sequences whose every step is table-legal", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<FsmEntity>("game", "claim", "intent", "payout"),
        fc.array(fc.nat(), { maxLength: 50 }),
        (entity, choices) => {
          const states = STATES[entity];
          let current = states[0] ?? "";
          let allLegal = true;
          for (const choice of choices) {
            const next = states[choice % states.length] ?? "";
            const legal = canTransition(entity, current, next);
            allLegal &&= legal;
            if (legal) {
              current = next;
            }
          }

          const hasIllegalStep = choices.some((choice, index) => {
            let from = states[0] ?? "";
            for (let previous = 0; previous < index; previous += 1) {
              const candidate =
                states[(choices[previous] ?? 0) % states.length] ?? "";
              if (canTransition(entity, from, candidate)) {
                from = candidate;
              }
            }
            const to = states[choice % states.length] ?? "";
            return !canTransition(entity, from, to);
          });
          expect(allLegal).toBe(!hasIllegalStep);
        },
      ),
    );
  });
});

describe("FSM contextual guards", () => {
  it("claimExpiryDue follows the defer truth table and exact deadline boundary", () => {
    const claim = { status: "open" as const, deadline: 1_000 };
    expect(claimExpiryDue(claim, false, 999)).toBe(false);
    expect(claimExpiryDue(claim, false, 1_000)).toBe(true);
    expect(claimExpiryDue(claim, true, 1_001)).toBe(false);
    expect(claimExpiryDue({ ...claim, status: "moved" }, false, 1_001)).toBe(
      false,
    );
    expect(claimExpiryDue({ ...claim, status: "expired" }, false, 1_001)).toBe(
      false,
    );
  });

  it("gameStallDue is due at exactly STALL_ABORT_HOURS and never terminal", () => {
    const threshold = RULES.STALL_ABORT_HOURS * 60 * 60 * 1_000;
    expect(
      gameStallDue({ status: "active", lastPlyAt: 100 }, threshold + 99, RULES),
    ).toBe(false);
    expect(
      gameStallDue(
        { status: "active", lastPlyAt: 100 },
        threshold + 100,
        RULES,
      ),
    ).toBe(true);
    expect(
      gameStallDue(
        { status: "finished", lastPlyAt: 100 },
        threshold + 100,
        RULES,
      ),
    ).toBe(false);
    expect(
      gameStallDue(
        { status: "aborted", lastPlyAt: 100 },
        threshold + 100,
        RULES,
      ),
    ).toBe(false);
  });

  it("nextClaimDelaySeconds is zero in endspiel and configured otherwise", () => {
    expect(nextClaimDelaySeconds("endspiel", RULES)).toBe(0);
    expect(nextClaimDelaySeconds("normal", RULES)).toBe(
      RULES.MIN_PLY_INTERVAL_SECONDS,
    );
  });
});
