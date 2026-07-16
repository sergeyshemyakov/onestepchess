import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { gameRulesSchema } from "../config.js";
import type { GameResult } from "../types.js";
import { GOLDEN_FIXTURES } from "./golden.js";
import { type Resolution, type ResolveEntry, resolve } from "./resolve.js";

const cfg = gameRulesSchema.parse({});

function floorDiv(numerator: number, denominator: number): number {
  return (numerator - (numerator % denominator)) / denominator;
}

const multBps = floorDiv(cfg.HUMAN_TARGET_MULT * 10_000 + 0.5, 1);

function entry(overrides: Partial<ResolveEntry> = {}): ResolveEntry {
  return {
    entryId: "e1",
    player: "P1",
    side: "white",
    kind: "agent",
    amountMicroUsdc: 1_000,
    ...overrides,
  };
}

function totalPaid(resolution: Resolution): number {
  return resolution.payouts.reduce((sum, p) => sum + p.amountMicroUsdc, 0);
}

function paidToEntry(resolution: Resolution, entryId: string): number {
  return resolution.payouts
    .filter((p) => p.entryId === entryId)
    .reduce((sum, p) => sum + p.amountMicroUsdc, 0);
}

const entriesArb: fc.Arbitrary<ResolveEntry[]> = fc
  .array(
    fc.record({
      player: fc.integer({ min: 0, max: 9 }).map((n) => `P${n}`),
      side: fc.constantFrom("white" as const, "black" as const),
      kind: fc.constantFrom("human" as const, "agent" as const),
      amountMicroUsdc: fc.integer({ min: 1, max: 1_000_000 }),
    }),
    { maxLength: 64 },
  )
  .map((rows) => rows.map((row, i) => ({ ...row, entryId: `e${i}` })));

const resultArb: fc.Arbitrary<GameResult> = fc.constantFrom(
  "white",
  "black",
  "draw",
  "aborted",
);

describe("golden fixtures", () => {
  it("goldens A-C deep-equal the exported fixtures at default config", () => {
    expect(GOLDEN_FIXTURES).toHaveLength(3);
    for (const fixture of GOLDEN_FIXTURES) {
      expect(resolve(fixture.entries, fixture.result, cfg)).toEqual(
        fixture.expected,
      );
    }
  });

  it("golden A doubles every human and pays agents 500 bonus with a zero take", () => {
    const goldenA = GOLDEN_FIXTURES[0];
    if (goldenA === undefined) {
      throw new Error("golden A missing");
    }
    const resolution = resolve(goldenA.entries, goldenA.result, cfg);
    const whiteHumans = goldenA.entries.filter(
      (e) => e.side === "white" && e.kind === "human",
    );
    for (const human of whiteHumans) {
      expect(paidToEntry(resolution, human.entryId)).toBe(
        2 * human.amountMicroUsdc,
      );
    }
    expect(resolution.take).toEqual({
      feeMicroUsdc: 0,
      dustMicroUsdc: 0,
      surplusMicroUsdc: 0,
    });
    expect(totalPaid(resolution)).toBe(67_000);
  });

  it("golden B binds the human cap with dust 2", () => {
    const goldenB = GOLDEN_FIXTURES[1];
    if (goldenB === undefined) {
      throw new Error("golden B missing");
    }
    const resolution = resolve(goldenB.entries, goldenB.result, cfg);
    expect(resolution.take).toEqual({
      feeMicroUsdc: 0,
      dustMicroUsdc: 2,
      surplusMicroUsdc: 0,
    });
    expect(totalPaid(resolution)).toBe(36_998);
  });

  it("golden C refunds every entry in full on a draw", () => {
    const goldenC = GOLDEN_FIXTURES[2];
    if (goldenC === undefined) {
      throw new Error("golden C missing");
    }
    const resolution = resolve(goldenC.entries, goldenC.result, cfg);
    for (const e of goldenC.entries) {
      expect(paidToEntry(resolution, e.entryId)).toBe(e.amountMicroUsdc);
    }
    expect(resolution.take).toEqual({
      feeMicroUsdc: 0,
      dustMicroUsdc: 0,
      surplusMicroUsdc: 0,
    });
  });
});

describe("resolve properties", () => {
  it("conserves every microUSDC over random entry sets", () => {
    fc.assert(
      fc.property(entriesArb, resultArb, (entries, result) => {
        const resolution = resolve(entries, result, cfg);
        const stakes = entries.reduce((sum, e) => sum + e.amountMicroUsdc, 0);
        expect(
          totalPaid(resolution) +
            resolution.take.feeMicroUsdc +
            resolution.take.dustMicroUsdc +
            resolution.take.surplusMicroUsdc,
        ).toBe(stakes);
      }),
    );
  });

  it("pays every winner at least its principal", () => {
    fc.assert(
      fc.property(
        entriesArb,
        fc.constantFrom("white" as const, "black" as const),
        (entries, result) => {
          const resolution = resolve(entries, result, cfg);
          for (const e of entries.filter((e) => e.side === result)) {
            expect(paidToEntry(resolution, e.entryId)).toBeGreaterThanOrEqual(
              e.amountMicroUsdc,
            );
          }
        },
      ),
    );
  });

  it("caps every human total at amount plus target", () => {
    fc.assert(
      fc.property(
        entriesArb,
        fc.constantFrom("white" as const, "black" as const),
        (entries, result) => {
          const resolution = resolve(entries, result, cfg);
          const humans = entries.filter(
            (e) => e.side === result && e.kind === "human",
          );
          for (const h of humans) {
            const target = floorDiv(
              h.amountMicroUsdc * (multBps - 10_000),
              10_000,
            );
            expect(paidToEntry(resolution, h.entryId)).toBeLessThanOrEqual(
              h.amountMicroUsdc + target,
            );
          }
        },
      ),
    );
  });

  it("refunds draws and aborts exactly", () => {
    const drawFeeCfg = gameRulesSchema.parse({ DRAW_FEE: 500 });
    fc.assert(
      fc.property(
        entriesArb,
        fc.constantFrom("draw" as const, "aborted" as const),
        (entries, result) => {
          const resolution = resolve(entries, result, drawFeeCfg);
          for (const e of entries) {
            const clamped = e.amountMicroUsdc < 500 ? e.amountMicroUsdc : 500;
            const fee = result === "draw" && e.kind === "agent" ? clamped : 0;
            expect(paidToEntry(resolution, e.entryId)).toBe(
              e.amountMicroUsdc - fee,
            );
          }
        },
      ),
    );
  });

  it("only ever pays staking addresses and never exceeds the pot", () => {
    fc.assert(
      fc.property(entriesArb, resultArb, (entries, result) => {
        const resolution = resolve(entries, result, cfg);
        const stakers = new Set(entries.map((e) => e.player));
        for (const p of resolution.payouts) {
          expect(stakers.has(p.player)).toBe(true);
        }
        expect(totalPaid(resolution)).toBeLessThanOrEqual(
          entries.reduce((sum, e) => sum + e.amountMicroUsdc, 0),
        );
      }),
    );
  });

  it("emits no zero or negative components", () => {
    fc.assert(
      fc.property(entriesArb, resultArb, (entries, result) => {
        const resolution = resolve(entries, result, cfg);
        for (const p of resolution.payouts) {
          expect(p.amountMicroUsdc).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("is deterministic: double runs deep-equal", () => {
    fc.assert(
      fc.property(entriesArb, resultArb, (entries, result) => {
        expect(resolve(entries, result, cfg)).toEqual(
          resolve(entries, result, cfg),
        );
      }),
    );
  });
});

describe("edge fixtures", () => {
  it("resolves empty entries to an empty resolution with zero take", () => {
    for (const result of ["white", "black", "draw", "aborted"] as const) {
      expect(resolve([], result, cfg)).toEqual({
        payouts: [],
        take: { feeMicroUsdc: 0, dustMicroUsdc: 0, surplusMicroUsdc: 0 },
      });
    }
  });

  it("pays principals only when nobody staked the losing side", () => {
    const entries = [
      entry({
        entryId: "w1",
        player: "PW1",
        side: "white",
        kind: "human",
        amountMicroUsdc: 10_000,
      }),
      entry({
        entryId: "w2",
        player: "PW2",
        side: "white",
        amountMicroUsdc: 1_000,
      }),
    ];
    expect(resolve(entries, "white", cfg)).toEqual({
      payouts: [
        {
          entryId: "w1",
          player: "PW1",
          tag: "principal",
          amountMicroUsdc: 10_000,
        },
        {
          entryId: "w2",
          player: "PW2",
          tag: "principal",
          amountMicroUsdc: 1_000,
        },
      ],
      take: { feeMicroUsdc: 0, dustMicroUsdc: 0, surplusMicroUsdc: 0 },
    });
  });

  it("moves the whole pot to surplus when nobody staked the winning side", () => {
    const entries = [
      entry({ entryId: "w1", side: "white", amountMicroUsdc: 4_000 }),
      entry({ entryId: "w2", side: "white", amountMicroUsdc: 6_000 }),
    ];
    expect(resolve(entries, "black", cfg)).toEqual({
      payouts: [],
      take: { feeMicroUsdc: 0, dustMicroUsdc: 0, surplusMicroUsdc: 10_000 },
    });
  });

  it("routes the post-cap prize to surplus when the winning side is all-human", () => {
    const entries = [
      entry({
        entryId: "h1",
        player: "PH1",
        side: "white",
        kind: "human",
        amountMicroUsdc: 1_000,
      }),
      entry({
        entryId: "a1",
        player: "PA1",
        side: "black",
        amountMicroUsdc: 5_000,
      }),
    ];
    expect(resolve(entries, "white", cfg)).toEqual({
      payouts: [
        {
          entryId: "h1",
          player: "PH1",
          tag: "principal",
          amountMicroUsdc: 1_000,
        },
        { entryId: "h1", player: "PH1", tag: "bonus", amountMicroUsdc: 1_000 },
      ],
      take: { feeMicroUsdc: 0, dustMicroUsdc: 0, surplusMicroUsdc: 4_000 },
    });
  });

  it("gives agents the whole prize when the winning side is all-agent", () => {
    const entries = [
      entry({
        entryId: "a1",
        player: "PA1",
        side: "white",
        amountMicroUsdc: 1_000,
      }),
      entry({
        entryId: "a2",
        player: "PA2",
        side: "white",
        amountMicroUsdc: 1_000,
      }),
      entry({
        entryId: "h1",
        player: "PH1",
        side: "black",
        kind: "human",
        amountMicroUsdc: 10_000,
      }),
    ];
    expect(resolve(entries, "white", cfg)).toEqual({
      payouts: [
        {
          entryId: "a1",
          player: "PA1",
          tag: "principal",
          amountMicroUsdc: 1_000,
        },
        {
          entryId: "a2",
          player: "PA2",
          tag: "principal",
          amountMicroUsdc: 1_000,
        },
        { entryId: "a1", player: "PA1", tag: "bonus", amountMicroUsdc: 5_000 },
        { entryId: "a2", player: "PA2", tag: "bonus", amountMicroUsdc: 5_000 },
      ],
      take: { feeMicroUsdc: 0, dustMicroUsdc: 0, surplusMicroUsdc: 0 },
    });
  });

  it("clamps the draw fee at the agent's stake", () => {
    const clampCfg = gameRulesSchema.parse({ DRAW_FEE: 2_000 });
    const entries = [
      entry({
        entryId: "a1",
        player: "PA1",
        side: "white",
        amountMicroUsdc: 1_000,
      }),
      entry({
        entryId: "a2",
        player: "PA2",
        side: "black",
        amountMicroUsdc: 5_000,
      }),
    ];
    expect(resolve(entries, "draw", clampCfg)).toEqual({
      payouts: [
        { entryId: "a2", player: "PA2", tag: "refund", amountMicroUsdc: 3_000 },
      ],
      take: { feeMicroUsdc: 3_000, dustMicroUsdc: 0, surplusMicroUsdc: 0 },
    });
  });

  it("applies the fee slot after human bonuses: golden A at 500 bps pays 475 per agent and 450 fee", () => {
    const feeCfg = gameRulesSchema.parse({ PROTOCOL_FEE_BPS: 500 });
    const goldenA = GOLDEN_FIXTURES[0];
    if (goldenA === undefined) {
      throw new Error("golden A missing");
    }
    const resolution = resolve(goldenA.entries, goldenA.result, feeCfg);
    const agentBonuses = resolution.payouts.filter(
      (p) => p.tag === "bonus" && p.entryId.startsWith("A-wa"),
    );
    expect(agentBonuses).toHaveLength(18);
    for (const bonus of agentBonuses) {
      expect(bonus.amountMicroUsdc).toBe(475);
    }
    expect(resolution.take).toEqual({
      feeMicroUsdc: 450,
      dustMicroUsdc: 0,
      surplusMicroUsdc: 0,
    });
  });
});
