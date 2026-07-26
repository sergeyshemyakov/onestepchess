import type { GameRules } from "../config.js";
import {
  CoreError,
  type GameResult,
  type MicroUsdc,
  type Side,
  type StakeKind,
} from "../types.js";

export type ResolveEntry = {
  readonly entryId: string;
  readonly player: string;
  readonly side: Side;
  readonly kind: StakeKind;
  readonly amountMicroUsdc: MicroUsdc;
};

export type PayoutComponent = {
  readonly entryId: string;
  readonly player: string;
  readonly tag: "principal" | "bonus" | "refund";
  readonly amountMicroUsdc: MicroUsdc;
};

export type ResolveTake = {
  readonly feeMicroUsdc: MicroUsdc;
  readonly dustMicroUsdc: MicroUsdc;
  readonly surplusMicroUsdc: MicroUsdc;
};

export type Resolution = {
  readonly payouts: readonly PayoutComponent[];
  readonly take: ResolveTake;
};

function floorDiv(numerator: number, denominator: number): number {
  return (numerator - (numerator % denominator)) / denominator;
}

function roundPositive(value: number): number {
  return floorDiv(value + 0.5, 1);
}

function sumStakes(entries: readonly ResolveEntry[]): MicroUsdc {
  return entries.reduce((sum, entry) => sum + entry.amountMicroUsdc, 0);
}

function distributeProRata(
  entries: readonly ResolveEntry[],
  amountMicroUsdc: MicroUsdc,
  pay: (entry: ResolveEntry, amountMicroUsdc: MicroUsdc) => void,
): MicroUsdc {
  const totalStake = sumStakes(entries);
  let allocated = 0;
  for (const entry of entries) {
    const amount = floorDiv(
      amountMicroUsdc * entry.amountMicroUsdc,
      totalStake,
    );
    allocated += amount;
    pay(entry, amount);
  }
  return amountMicroUsdc - allocated;
}

/** The normative §9.2 algorithm in integer µUSDC. Component order is
 * normative: principals → human bonuses (capped at target) → fee slot →
 * agent pro-rata; rounding remainders go to dust, missing cohorts to surplus. */
export function resolve(
  entries: readonly ResolveEntry[],
  result: GameResult,
  cfg: GameRules,
): Resolution {
  const payouts: PayoutComponent[] = [];
  let fee = 0;
  let dust = 0;
  let surplus = 0;

  const pay = (
    entry: ResolveEntry,
    tag: PayoutComponent["tag"],
    amountMicroUsdc: MicroUsdc,
  ): void => {
    if (amountMicroUsdc > 0) {
      payouts.push({
        entryId: entry.entryId,
        player: entry.player,
        tag,
        amountMicroUsdc,
      });
    }
  };

  if (result === "aborted") {
    for (const e of entries) {
      pay(e, "refund", e.amountMicroUsdc);
    }
  } else if (result === "draw") {
    for (const e of entries) {
      const clampedFee =
        cfg.DRAW_FEE < e.amountMicroUsdc ? cfg.DRAW_FEE : e.amountMicroUsdc;
      const cut = e.kind === "agent" ? clampedFee : 0;
      fee += cut;
      pay(e, "refund", e.amountMicroUsdc - cut);
    }
  } else {
    // HUMAN_TARGET_MULT is schema-constrained to ≤ 2 decimals, so the single
    // basis-point conversion below is exact (round to absorb float noise).
    const multBps = roundPositive(cfg.HUMAN_TARGET_MULT * 10_000);
    const winners = entries.filter((e) => e.side === result);
    let prize = sumStakes(entries.filter((e) => e.side !== result));

    for (const w of winners) {
      pay(w, "principal", w.amountMicroUsdc);
    }

    if (winners.length === 0) {
      surplus += prize;
    } else {
      const humans = winners.filter((e) => e.kind === "human");
      const target = (h: ResolveEntry): number =>
        floorDiv(h.amountMicroUsdc * (multBps - 10_000), 10_000);
      const need = humans.reduce((sum, h) => sum + target(h), 0);

      if (prize >= need) {
        for (const h of humans) {
          pay(h, "bonus", target(h));
        }
        prize -= need;
      } else {
        dust += distributeProRata(humans, prize, (entry, amount) =>
          pay(entry, "bonus", amount),
        );
        prize = 0;
      }

      const feeCut = floorDiv(prize * cfg.PROTOCOL_FEE_BPS, 10_000);
      fee += feeCut;
      const rest = prize - feeCut;

      const agents = winners.filter((e) => e.kind === "agent");
      if (agents.length === 0) {
        surplus += rest;
      } else {
        dust += distributeProRata(agents, rest, (entry, amount) =>
          pay(entry, "bonus", amount),
        );
      }
    }
  }

  const paid = payouts.reduce((sum, p) => sum + p.amountMicroUsdc, 0);
  const staked = sumStakes(entries);
  if (paid + fee + dust + surplus !== staked) {
    throw new CoreError(
      "CONSERVATION",
      `payouts ${paid} + take ${fee + dust + surplus} != stakes ${staked}`,
    );
  }

  return {
    payouts,
    take: {
      feeMicroUsdc: fee,
      dustMicroUsdc: dust,
      surplusMicroUsdc: surplus,
    },
  };
}
