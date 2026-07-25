import { OscClientError } from "./errors.js";

export type BudgetGuardOptions = {
  readonly maxStakeMicroUsdc?: number;
  readonly sessionBudgetMicroUsdc?: number;
};

export class BudgetGuard {
  readonly maxStakeMicroUsdc: number;
  readonly sessionBudgetMicroUsdc: number;
  readonly #reservations = new Map<string, number>();

  constructor(options: BudgetGuardOptions = {}) {
    this.maxStakeMicroUsdc = options.maxStakeMicroUsdc ?? 5_000;
    this.sessionBudgetMicroUsdc = options.sessionBudgetMicroUsdc ?? 100_000;
    if (
      !Number.isSafeInteger(this.maxStakeMicroUsdc) ||
      this.maxStakeMicroUsdc <= 0 ||
      !Number.isSafeInteger(this.sessionBudgetMicroUsdc) ||
      this.sessionBudgetMicroUsdc <= 0
    ) {
      throw new RangeError("budget caps must be positive safe integers");
    }
  }

  reserve(claimId: string, amountMicroUsdc: number): void {
    const existing = this.#reservations.get(claimId);
    if (existing !== undefined) {
      if (existing !== amountMicroUsdc) {
        throw new OscClientError(
          "NETWORK_MISMATCH",
          `claim ${claimId} changed amount from ${existing} to ${amountMicroUsdc}`,
        );
      }
      return;
    }
    const spent = this.spent();
    if (
      !Number.isSafeInteger(amountMicroUsdc) ||
      amountMicroUsdc <= 0 ||
      amountMicroUsdc > this.maxStakeMicroUsdc ||
      spent + amountMicroUsdc > this.sessionBudgetMicroUsdc
    ) {
      throw new OscClientError(
        "BUDGET_EXCEEDED",
        `payment ${amountMicroUsdc} µUSDC exceeds max stake ${this.maxStakeMicroUsdc} µUSDC or session budget ${this.sessionBudgetMicroUsdc} µUSDC (reserved/spent ${spent} µUSDC); raise OSC_MAX_STAKE_MICROUSDC or OSC_SESSION_BUDGET_MICROUSDC only after reviewing the spend`,
      );
    }
    this.#reservations.set(claimId, amountMicroUsdc);
  }

  release(claimId: string): void {
    this.#reservations.delete(claimId);
  }

  has(claimId: string): boolean {
    return this.#reservations.has(claimId);
  }

  spent(): number {
    let total = 0;
    for (const amount of this.#reservations.values()) total += amount;
    return total;
  }

  remaining(): number {
    return this.sessionBudgetMicroUsdc - this.spent();
  }
}
