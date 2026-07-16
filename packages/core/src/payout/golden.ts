import type { GameResult } from "../types.js";
import type { PayoutComponent, Resolution, ResolveEntry } from "./resolve.js";

export type GoldenFixture = {
  readonly name: string;
  readonly entries: readonly ResolveEntry[];
  readonly result: GameResult;
  /** Exact expected resolution at the default GameRules. */
  readonly expected: Resolution;
};

function entry(
  entryId: string,
  side: "white" | "black",
  kind: "human" | "agent",
  amountMicroUsdc: number,
): ResolveEntry {
  return { entryId, player: `p:${entryId}`, side, kind, amountMicroUsdc };
}

function component(
  entryId: string,
  tag: PayoutComponent["tag"],
  amountMicroUsdc: number,
): PayoutComponent {
  return { entryId, player: `p:${entryId}`, tag, amountMicroUsdc };
}

function range(
  count: number,
  make: (n: number) => ResolveEntry,
): ResolveEntry[] {
  return Array.from({ length: count }, (_, i) => make(i + 1));
}

/** A — liquid decisive: white wins, every white human doubles, agents +500. */
const goldenAEntries: readonly ResolveEntry[] = [
  entry("A-wh1", "white", "human", 10_000),
  entry("A-wh2", "white", "human", 10_000),
  ...range(18, (n) => entry(`A-wa${n}`, "white", "agent", 1_000)),
  entry("A-bh1", "black", "human", 10_000),
  ...range(19, (n) => entry(`A-ba${n}`, "black", "agent", 1_000)),
];

export const GOLDEN_A: GoldenFixture = {
  name: "A — liquid decisive",
  entries: goldenAEntries,
  result: "white",
  expected: {
    payouts: [
      component("A-wh1", "principal", 10_000),
      component("A-wh2", "principal", 10_000),
      ...range(18, (n) => entry(`A-wa${n}`, "white", "agent", 1_000)).map((e) =>
        component(e.entryId, "principal", 1_000),
      ),
      component("A-wh1", "bonus", 10_000),
      component("A-wh2", "bonus", 10_000),
      ...range(18, (n) => entry(`A-wa${n}`, "white", "agent", 1_000)).map((e) =>
        component(e.entryId, "bonus", 500),
      ),
    ],
    take: { feeMicroUsdc: 0, dustMicroUsdc: 0, surplusMicroUsdc: 0 },
  },
};

/** B — thin pot: prize 5000 < need 30000, human cap binds, dust 2. */
const goldenBEntries: readonly ResolveEntry[] = [
  entry("B-wh1", "white", "human", 10_000),
  entry("B-wh2", "white", "human", 10_000),
  entry("B-wh3", "white", "human", 10_000),
  entry("B-wa1", "white", "agent", 1_000),
  entry("B-wa2", "white", "agent", 1_000),
  ...range(5, (n) => entry(`B-ba${n}`, "black", "agent", 1_000)),
];

export const GOLDEN_B: GoldenFixture = {
  name: "B — thin pot, human cap binds",
  entries: goldenBEntries,
  result: "white",
  expected: {
    payouts: [
      component("B-wh1", "principal", 10_000),
      component("B-wh2", "principal", 10_000),
      component("B-wh3", "principal", 10_000),
      component("B-wa1", "principal", 1_000),
      component("B-wa2", "principal", 1_000),
      component("B-wh1", "bonus", 1_666),
      component("B-wh2", "bonus", 1_666),
      component("B-wh3", "bonus", 1_666),
    ],
    take: { feeMicroUsdc: 0, dustMicroUsdc: 2, surplusMicroUsdc: 0 },
  },
};

/** C — draw over B's entry set: every entry refunded in full. */
const goldenCEntries: readonly ResolveEntry[] = [
  entry("C-wh1", "white", "human", 10_000),
  entry("C-wh2", "white", "human", 10_000),
  entry("C-wh3", "white", "human", 10_000),
  entry("C-wa1", "white", "agent", 1_000),
  entry("C-wa2", "white", "agent", 1_000),
  ...range(5, (n) => entry(`C-ba${n}`, "black", "agent", 1_000)),
];

export const GOLDEN_C: GoldenFixture = {
  name: "C — draw",
  entries: goldenCEntries,
  result: "draw",
  expected: {
    payouts: goldenCEntries.map((e) =>
      component(e.entryId, "refund", e.amountMicroUsdc),
    ),
    take: { feeMicroUsdc: 0, dustMicroUsdc: 0, surplusMicroUsdc: 0 },
  },
};

export const GOLDEN_FIXTURES: readonly GoldenFixture[] = [
  GOLDEN_A,
  GOLDEN_B,
  GOLDEN_C,
];
