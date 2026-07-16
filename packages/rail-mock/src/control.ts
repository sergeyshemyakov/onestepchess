import type { MicroUsdc, TxStatus, VerifyResult } from "@onestepchess/core";

export type Scripted<T> = T | { readonly latencyMs: number; readonly then: T };

export type ScriptedSettle =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "rejected" | "expired";
      readonly detail?: string;
    }
  | {
      readonly ok: false;
      readonly reason: "unavailable";
      readonly applied?: boolean;
      readonly detail?: string;
    };

export type ScriptedSubmit =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "rejected";
      readonly detail?: string;
    }
  | {
      readonly ok: false;
      readonly reason: "unavailable";
      readonly applied?: boolean;
      readonly detail?: string;
    };

export type QueryCode = "status" | "note" | "balances" | "account";
export type NoteResult = {
  readonly txid: string;
  readonly confirmedRound: number;
} | null;
export type AccountInfo = {
  readonly exists: boolean;
  readonly rekeyed: boolean;
  readonly optedInUsdc: boolean;
  readonly spendableAlgoMicro: number;
};
export type Balances = {
  readonly usdcMicroUsdc: MicroUsdc;
  readonly algoMicroAlgo: number;
};

export interface MockControl {
  queueVerify(...outcomes: Scripted<VerifyResult>[]): void;
  queueSettle(...outcomes: Scripted<ScriptedSettle>[]): void;
  queueSubmitPrepared(...outcomes: Scripted<ScriptedSubmit>[]): void;
  queueSubmitSignedTransaction(...outcomes: Scripted<ScriptedSubmit>[]): void;
  setHealth(healthy: boolean): void;
  setLatency(ms: {
    readonly verifyMs?: number;
    readonly settleMs?: number;
  }): void;
  setBalances(address: string, balances: Partial<Balances>): void;
  setAccountInfo(address: string, info: Partial<AccountInfo>): void;
  setTxStatus(txid: string, status: TxStatus): void;
  setNoteResult(jobId: string, result: NoteResult): void;
  setFundingNoteResult(
    player: string,
    leg: "algo" | "usdc",
    result: NoteResult,
  ): void;
  failQueries(codes?: readonly QueryCode[]): void;
  restoreQueries(): void;
  setRound(round: number): void;
  reset(): void;
}

export class MockControlState implements MockControl {
  readonly verifyQueue: Scripted<VerifyResult>[] = [];
  readonly settleQueue: Scripted<ScriptedSettle>[] = [];
  readonly preparedQueue: Scripted<ScriptedSubmit>[] = [];
  readonly signedQueue: Scripted<ScriptedSubmit>[] = [];
  readonly balanceOverrides = new Map<string, Partial<Balances>>();
  readonly accountOverrides = new Map<string, Partial<AccountInfo>>();
  readonly statusOverrides = new Map<string, TxStatus>();
  readonly noteOverrides = new Map<string, NoteResult>();
  readonly fundingNoteOverrides = new Map<string, NoteResult>();
  readonly failedQueries = new Set<QueryCode>();
  healthy = true;
  verifyLatencyMs = 0;
  settleLatencyMs = 0;

  constructor(
    private readonly setRoundValue: (round: number) => void,
    private readonly resetState: () => void,
  ) {}

  queueVerify(...outcomes: Scripted<VerifyResult>[]): void {
    this.verifyQueue.push(...outcomes);
  }

  queueSettle(...outcomes: Scripted<ScriptedSettle>[]): void {
    this.settleQueue.push(...outcomes);
  }

  queueSubmitPrepared(...outcomes: Scripted<ScriptedSubmit>[]): void {
    this.preparedQueue.push(...outcomes);
  }

  queueSubmitSignedTransaction(...outcomes: Scripted<ScriptedSubmit>[]): void {
    this.signedQueue.push(...outcomes);
  }

  setHealth(healthy: boolean): void {
    this.healthy = healthy;
  }

  setLatency(ms: {
    readonly verifyMs?: number;
    readonly settleMs?: number;
  }): void {
    if (ms.verifyMs !== undefined) this.verifyLatencyMs = ms.verifyMs;
    if (ms.settleMs !== undefined) this.settleLatencyMs = ms.settleMs;
  }

  setBalances(address: string, balances: Partial<Balances>): void {
    this.balanceOverrides.set(address, balances);
  }

  setAccountInfo(address: string, info: Partial<AccountInfo>): void {
    this.accountOverrides.set(address, info);
  }

  setTxStatus(txid: string, status: TxStatus): void {
    this.statusOverrides.set(txid, status);
  }

  setNoteResult(jobId: string, result: NoteResult): void {
    this.noteOverrides.set(jobId, result);
  }

  setFundingNoteResult(
    player: string,
    leg: "algo" | "usdc",
    result: NoteResult,
  ): void {
    this.fundingNoteOverrides.set(`${leg}:${player}`, result);
  }

  failQueries(
    codes: readonly QueryCode[] = ["status", "note", "balances", "account"],
  ): void {
    for (const code of codes) this.failedQueries.add(code);
  }

  restoreQueries(): void {
    this.failedQueries.clear();
  }

  setRound(round: number): void {
    this.setRoundValue(round);
  }

  reset(): void {
    this.verifyQueue.length = 0;
    this.settleQueue.length = 0;
    this.preparedQueue.length = 0;
    this.signedQueue.length = 0;
    this.balanceOverrides.clear();
    this.accountOverrides.clear();
    this.statusOverrides.clear();
    this.noteOverrides.clear();
    this.fundingNoteOverrides.clear();
    this.failedQueries.clear();
    this.healthy = true;
    this.verifyLatencyMs = 0;
    this.settleLatencyMs = 0;
    this.resetState();
  }
}

export function unwrapScripted<T>(scripted: Scripted<T>): {
  value: T;
  latencyMs?: number;
} {
  if ("latencyMs" in (scripted as object)) {
    const wrapped = scripted as {
      readonly latencyMs: number;
      readonly then: T;
    };
    return { value: wrapped.then, latencyMs: wrapped.latencyMs };
  }
  return { value: scripted as T };
}
