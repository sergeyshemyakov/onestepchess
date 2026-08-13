import type {
  DecodeResult,
  FundingInstruction,
  MicroUsdc,
  PaymentChallenge,
  PaymentRail,
  PaymentRequired,
  PayoutInstruction,
  PreparedFunding,
  PreparedPayouts,
  PreparedSubmission,
  SendResult,
  SettleResult,
  SignedSubmitResult,
  StakeQuote,
  SweepQuote,
  SweepTxn,
  TxStatus,
  VerifyResult,
} from "@onestepchess/core";
import {
  MOVE_RESOURCE_DESCRIPTION,
  MOVE_RESOURCE_MIME_TYPE,
  moveBazaarExtensions,
  RailError,
  X402_GLOBAL_CHALLENGE_TAG,
} from "@onestepchess/core";
import algosdk from "algosdk";
import {
  type AccountInfo,
  type Balances,
  type MockControl,
  MockControlState,
  type NoteResult,
  type Scripted,
  type ScriptedSettle,
  type ScriptedSubmit,
  unwrapScripted,
} from "./control.js";
import {
  decodeMockPayment,
  encodeBase64Json,
  MOCK_NETWORK,
  MOCK_SCHEME,
  matchesMockPaymentRequirement,
} from "./header.js";

const DEFAULT_TREASURY = "MOCK_TREASURY";
// A real (deterministic) Algorand address: sweep transactions are genuine
// algosdk payloads whose receiver must pass address validation, exactly like
// the opt-in flow builds a genuine self-transfer.
const DEFAULT_BONUS = algosdk.encodeAddress(new Uint8Array(32).fill(9));
const DEFAULT_USDC_ASSET = "31566704";
const DEFAULT_MAX_TIMEOUT_SECONDS = 120;
const DEFAULT_BALANCE = 10_000_000;
const INITIAL_ROUND = 1_000;
const MAINNET_GENESIS_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

type PreparedRecord =
  | {
      readonly prepared: PreparedPayouts;
      readonly instructions: readonly PayoutInstruction[];
    }
  | {
      readonly prepared: PreparedFunding;
      readonly instruction: FundingInstruction;
    };

type Confirmed = {
  readonly status: "confirmed";
  readonly confirmedRound: number;
};

export interface MockRailState {
  readonly kind: "MockRailState";
}

class MutableMockRailState implements MockRailState {
  readonly kind = "MockRailState" as const;
  readonly initial: Balances;
  readonly initialBonus: Balances;
  balances: Balances;
  bonusBalances: Balances;
  txCounter = 0;
  groupCounter = 0;
  currentRound = INITIAL_ROUND;
  readonly confirmed = new Map<string, Confirmed>();
  readonly settlements = new Map<
    string,
    SettleResult & { readonly ok: true }
  >();
  readonly prepared = new Map<string, PreparedRecord>();
  readonly appliedPayloads = new Set<string>();
  readonly payoutNotes = new Map<string, Exclude<NoteResult, null>>();
  readonly fundingNotes = new Map<string, Exclude<NoteResult, null>>();

  constructor(
    initial?: MockRailOptions["initialTreasury"],
    initialBonus?: MockRailOptions["initialBonus"],
  ) {
    this.initial = {
      usdcMicroUsdc: initial?.usdcMicroUsdc ?? DEFAULT_BALANCE,
      algoMicroAlgo: initial?.algoMicroAlgo ?? DEFAULT_BALANCE,
    };
    this.initialBonus = {
      usdcMicroUsdc: initialBonus?.usdcMicroUsdc ?? DEFAULT_BALANCE,
      algoMicroAlgo: initialBonus?.algoMicroAlgo ?? DEFAULT_BALANCE,
    };
    this.balances = { ...this.initial };
    this.bonusBalances = { ...this.initialBonus };
  }

  reset(): void {
    this.balances = { ...this.initial };
    this.bonusBalances = { ...this.initialBonus };
    this.txCounter = 0;
    this.groupCounter = 0;
    this.currentRound = INITIAL_ROUND;
    this.confirmed.clear();
    this.settlements.clear();
    this.prepared.clear();
    this.appliedPayloads.clear();
    this.payoutNotes.clear();
    this.fundingNotes.clear();
  }
}

export type MockRailOptions = {
  readonly treasuryAddress?: string;
  readonly bonusAddress?: string;
  readonly initialTreasury?: {
    readonly usdcMicroUsdc?: MicroUsdc;
    readonly algoMicroAlgo?: number;
  };
  readonly initialBonus?: {
    readonly usdcMicroUsdc?: MicroUsdc;
    readonly algoMicroAlgo?: number;
  };
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly state?: MockRailState;
};

export interface MockRail extends PaymentRail {
  readonly control: MockControl;
}

export function createMockRailState(
  initial?: MockRailOptions["initialTreasury"],
  initialBonus?: MockRailOptions["initialBonus"],
): MockRailState {
  return new MutableMockRailState(initial, initialBonus);
}

function mutableState(
  state: MockRailState | undefined,
  initial: MockRailOptions["initialTreasury"],
  initialBonus: MockRailOptions["initialBonus"],
): MutableMockRailState {
  if (state === undefined)
    return new MutableMockRailState(initial, initialBonus);
  if (!(state instanceof MutableMockRailState)) {
    throw new RailError(
      "CONTRACT",
      "state must come from createMockRailState()",
    );
  }
  return state;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RailError(
      "CONTRACT",
      `${label} must be a non-negative safe integer`,
    );
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RailError("CONTRACT", `${label} must be a positive safe integer`);
  }
}

export function createMockRail(options: MockRailOptions = {}): MockRail {
  const treasuryAddress = options.treasuryAddress ?? DEFAULT_TREASURY;
  if (treasuryAddress.length === 0) {
    throw new RailError("CONTRACT", "treasuryAddress must not be empty");
  }
  const bonusAddress = options.bonusAddress ?? DEFAULT_BONUS;
  if (bonusAddress.length === 0 || bonusAddress === treasuryAddress) {
    throw new RailError(
      "CONTRACT",
      "bonusAddress must be non-empty and differ from treasuryAddress",
    );
  }
  if (options.initialTreasury?.usdcMicroUsdc !== undefined) {
    assertFiniteNonNegative(
      options.initialTreasury.usdcMicroUsdc,
      "initial USDC balance",
    );
  }
  if (options.initialTreasury?.algoMicroAlgo !== undefined) {
    assertFiniteNonNegative(
      options.initialTreasury.algoMicroAlgo,
      "initial ALGO balance",
    );
  }
  if (options.initialBonus?.usdcMicroUsdc !== undefined) {
    assertFiniteNonNegative(
      options.initialBonus.usdcMicroUsdc,
      "initial bonus USDC balance",
    );
  }
  if (options.initialBonus?.algoMicroAlgo !== undefined) {
    assertFiniteNonNegative(
      options.initialBonus.algoMicroAlgo,
      "initial bonus ALGO balance",
    );
  }

  const state = mutableState(
    options.state,
    options.initialTreasury,
    options.initialBonus,
  );
  const sleep = options.sleep ?? (async () => {});
  const control = new MockControlState(
    (round) => {
      assertFiniteNonNegative(round, "round");
      state.currentRound = round;
    },
    () => state.reset(),
  );

  function allocateTx(): { txid: string; round: number } {
    state.txCounter += 1;
    const txid = `mocktx_${String(state.txCounter).padStart(6, "0")}`;
    const round = state.currentRound;
    state.currentRound += 1;
    return { txid, round };
  }

  function confirm(txid: string, round: number): void {
    state.confirmed.set(txid, { status: "confirmed", confirmedRound: round });
  }

  async function delay(ms: number): Promise<void> {
    if (ms > 0) await sleep(ms);
  }

  async function takeScripted<T>(
    queue: Scripted<T>[],
    defaultLatencyMs = 0,
  ): Promise<T | undefined> {
    const scripted = queue.shift();
    if (scripted === undefined) {
      await delay(defaultLatencyMs);
      return undefined;
    }
    const outcome = unwrapScripted(scripted);
    await delay(outcome.latencyMs ?? defaultLatencyMs);
    return outcome.value;
  }

  function settleApplied(header: string): SettleResult & { readonly ok: true } {
    const decoded = decodeMockPayment(header);
    if (!decoded.ok) {
      throw new RailError("CONTRACT", "Cannot apply a malformed mock payment");
    }
    const prior = state.settlements.get(decoded.payment.clientTxId);
    if (prior !== undefined) return prior;
    const issued = allocateTx();
    const result = {
      ok: true,
      txid: issued.txid,
      confirmedRound: issued.round,
      paymentResponseHeader: encodePaymentResponse(issued.txid),
    } as const;
    state.settlements.set(decoded.payment.clientTxId, result);
    confirm(decoded.payment.clientTxId, issued.round);
    confirm(issued.txid, issued.round);
    state.balances = {
      ...state.balances,
      usdcMicroUsdc:
        state.balances.usdcMicroUsdc + decoded.payment.amountMicroUsdc,
    };
    return result;
  }

  function applyPrepared(prepared: PreparedSubmission): void {
    if (state.appliedPayloads.has(prepared.payloadB64)) return;
    const record = state.prepared.get(prepared.payloadB64);
    if (record === undefined || record.prepared.kind !== prepared.kind) {
      throw new RailError("CONTRACT", "Unknown or mutated prepared payload");
    }
    state.appliedPayloads.add(prepared.payloadB64);
    if (record.prepared.kind === "payouts") {
      const payouts = record as Extract<
        PreparedRecord,
        { prepared: PreparedPayouts }
      >;
      const amount = payouts.instructions.reduce(
        (sum, item) => sum + item.amountMicroUsdc,
        0,
      );
      state.balances = {
        ...state.balances,
        usdcMicroUsdc: state.balances.usdcMicroUsdc - amount,
      };
      for (const [index, item] of payouts.instructions.entries()) {
        const issued = payouts.prepared.txids[index];
        if (issued === undefined)
          throw new RailError("CONTRACT", "Missing prepared payout txid");
        const round = payouts.prepared.lastValidRound - 1_000;
        confirm(issued.txid, round);
        state.payoutNotes.set(item.jobId, {
          txid: issued.txid,
          confirmedRound: round,
        });
      }
      return;
    }
    const funding = record as Extract<
      PreparedRecord,
      { prepared: PreparedFunding }
    >;
    const round = funding.prepared.lastValidRound - 1_000;
    confirm(funding.prepared.txid, round);
    state.fundingNotes.set(
      `${funding.instruction.leg}:${funding.instruction.player}`,
      {
        txid: funding.prepared.txid,
        confirmedRound: round,
      },
    );
    state.bonusBalances =
      funding.instruction.leg === "usdc"
        ? {
            ...state.bonusBalances,
            usdcMicroUsdc:
              state.bonusBalances.usdcMicroUsdc - funding.instruction.amount,
          }
        : {
            ...state.bonusBalances,
            algoMicroAlgo:
              state.bonusBalances.algoMicroAlgo - funding.instruction.amount,
          };
  }

  function encodePaymentResponse(txid: string): string {
    return encodeBase64Json({
      success: true,
      transaction: txid,
      network: MOCK_NETWORK,
    });
  }

  function requireQuery(
    code: "status" | "note" | "balances" | "account",
  ): void {
    if (control.failedQueries.has(code)) {
      throw new RailError("UNAVAILABLE", `Mock ${code} query is unavailable`);
    }
  }

  const rail: MockRail = {
    treasuryAddress,
    bonusAddress,
    control,

    buildPaymentChallenge(quote: StakeQuote): PaymentChallenge {
      assertPositive(quote.amountMicroUsdc, "stake amount");
      if (quote.resource.length === 0) {
        throw new RailError("CONTRACT", "resource must not be empty");
      }
      const required: PaymentRequired = {
        x402Version: 2,
        resource: {
          url: quote.resource,
          description: MOVE_RESOURCE_DESCRIPTION,
          mimeType: MOVE_RESOURCE_MIME_TYPE,
        },
        accepts: [
          {
            scheme: MOCK_SCHEME,
            network: MOCK_NETWORK,
            asset: DEFAULT_USDC_ASSET,
            amount: String(quote.amountMicroUsdc),
            payTo: treasuryAddress,
            maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
            extra: { tag: X402_GLOBAL_CHALLENGE_TAG },
          },
        ],
        extensions: moveBazaarExtensions(),
      };
      return { required, header: encodeBase64Json(required) };
    },

    decodePayment(header: string): DecodeResult {
      return decodeMockPayment(header);
    },

    async verify(
      header: string,
      required: PaymentRequired,
    ): Promise<VerifyResult> {
      if (!matchesMockPaymentRequirement(header, required)) {
        return { ok: false, reason: "invalid_payment" };
      }
      return (
        (await takeScripted(control.verifyQueue, control.verifyLatencyMs)) ?? {
          ok: true,
        }
      );
    },

    async settle(
      header: string,
      _required: PaymentRequired,
    ): Promise<SettleResult> {
      const value: ScriptedSettle | undefined = await takeScripted(
        control.settleQueue,
        control.settleLatencyMs,
      );
      if (value === undefined) return settleApplied(header);
      if (value.ok) return settleApplied(header);
      if (value.reason === "unavailable" && value.applied === true)
        settleApplied(header);
      return {
        ok: false,
        reason: value.reason,
        ...(value.detail === undefined ? {} : { detail: value.detail }),
      };
    },

    encodePaymentResponse,

    async preparePayouts(
      batch: readonly PayoutInstruction[],
    ): Promise<PreparedPayouts> {
      if (batch.length === 0 || batch.length > 16) {
        throw new RailError(
          "CONTRACT",
          "Payout batch size must be between 1 and 16",
        );
      }
      const seenJobs = new Set<string>();
      for (const item of batch) {
        assertPositive(item.amountMicroUsdc, "payout amount");
        if (
          item.jobId.length === 0 ||
          item.recipient.length === 0 ||
          seenJobs.has(item.jobId)
        ) {
          throw new RailError(
            "CONTRACT",
            "Payout jobs require unique ids and recipients",
          );
        }
        seenJobs.add(item.jobId);
      }
      state.groupCounter += 1;
      const issued = batch.map((item) => ({
        jobId: item.jobId,
        ...allocateTx(),
      }));
      const lastIssuedRound = issued.at(-1)?.round ?? state.currentRound;
      const payloadB64 = encodeBase64Json({
        kind: "mock-prepared-payouts",
        group: state.groupCounter,
        jobs: batch,
        txids: issued.map(({ jobId, txid }) => ({ jobId, txid })),
      });
      const prepared: PreparedPayouts = {
        kind: "payouts",
        payloadB64,
        groupId: `mockgroup_${String(state.groupCounter).padStart(6, "0")}`,
        txids: issued.map(({ jobId, txid }) => ({ jobId, txid })),
        lastValidRound: lastIssuedRound + 1_000,
      };
      state.prepared.set(payloadB64, {
        prepared,
        instructions: batch.map((item) => ({ ...item })),
      });
      return prepared;
    },

    async prepareFunding(
      instruction: FundingInstruction,
    ): Promise<PreparedFunding> {
      assertPositive(instruction.amount, "funding amount");
      if (instruction.player.length === 0) {
        throw new RailError("CONTRACT", "Funding player must not be empty");
      }
      const issued = allocateTx();
      const payloadB64 = encodeBase64Json({
        kind: "mock-prepared-funding",
        instruction,
        txid: issued.txid,
      });
      const prepared: PreparedFunding = {
        kind: "funding",
        payloadB64,
        player: instruction.player,
        leg: instruction.leg,
        txid: issued.txid,
        lastValidRound: issued.round + 1_000,
      };
      state.prepared.set(payloadB64, {
        prepared,
        instruction: { ...instruction },
      });
      return prepared;
    },

    async submitPrepared(prepared: PreparedSubmission): Promise<SendResult> {
      const value: ScriptedSubmit | undefined = await takeScripted(
        control.preparedQueue,
      );
      if (value === undefined) {
        applyPrepared(prepared);
        return { ok: true };
      }
      if (value.ok) {
        applyPrepared(prepared);
        return { ok: true };
      }
      if (value.reason === "unavailable" && value.applied === true)
        applyPrepared(prepared);
      return {
        ok: false,
        reason: value.reason,
        ...(value.detail === undefined ? {} : { detail: value.detail }),
      };
    },

    async getTransactionStatus(txid: string): Promise<TxStatus> {
      requireQuery("status");
      return (
        control.statusOverrides.get(txid) ??
        state.confirmed.get(txid) ?? {
          status: "not_found",
          currentRound: state.currentRound,
        }
      );
    },

    async findPayoutByNote(jobId: string): Promise<NoteResult> {
      requireQuery("note");
      if (control.noteOverrides.has(jobId))
        return control.noteOverrides.get(jobId) ?? null;
      return state.payoutNotes.get(jobId) ?? null;
    },

    async findFundingByNote(
      player: string,
      leg: "algo" | "usdc",
    ): Promise<NoteResult> {
      requireQuery("note");
      const key = `${leg}:${player}`;
      if (control.fundingNoteOverrides.has(key))
        return control.fundingNoteOverrides.get(key) ?? null;
      return state.fundingNotes.get(key) ?? null;
    },

    async buildOptInTxn(address: string): Promise<string> {
      requireQuery("account");
      if (!algosdk.isValidAddress(address))
        throw new RailError("CONTRACT", "Opt-in address must not be empty");
      const transaction =
        algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: address,
          receiver: address,
          amount: 0,
          assetIndex: Number(DEFAULT_USDC_ASSET),
          suggestedParams: {
            flatFee: true,
            fee: 1_000,
            minFee: 1_000,
            firstValid: state.currentRound,
            lastValid: state.currentRound + 1_000,
            genesisID: "mainnet-v1.0",
            genesisHash: new Uint8Array(
              Buffer.from(MAINNET_GENESIS_HASH, "base64"),
            ),
          },
        });
      return Buffer.from(
        algosdk.encodeUnsignedTransaction(transaction),
      ).toString("base64");
    },

    async buildSweepTxns(address: string): Promise<SweepQuote> {
      requireQuery("account");
      if (!algosdk.isValidAddress(address))
        throw new RailError("CONTRACT", "Sweep address must be valid");
      const balances = {
        usdcMicroUsdc: 0,
        algoMicroAlgo: 0,
        ...control.balanceOverrides.get(address),
      };
      const account = {
        spendableAlgoMicro: 0,
        ...control.accountOverrides.get(address),
      };
      const fee = 1_000;
      const usdcAmount = balances.usdcMicroUsdc;
      const spendable = account.spendableAlgoMicro;
      const usdcLeg = usdcAmount > 0 && spendable >= fee;
      const algoAmount = spendable - fee * ((usdcLeg ? 1 : 0) + 1);
      const algoLeg = algoAmount > 0;
      if (!usdcLeg && !algoLeg) return { receiver: bonusAddress, txns: [] };
      const suggestedParams = {
        flatFee: true,
        fee,
        minFee: fee,
        firstValid: state.currentRound,
        lastValid: state.currentRound + 1_000,
        genesisID: "mainnet-v1.0",
        genesisHash: new Uint8Array(
          Buffer.from(MAINNET_GENESIS_HASH, "base64"),
        ),
      };
      const txns: SweepTxn[] = [];
      if (usdcLeg) {
        const transaction =
          algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: address,
            receiver: bonusAddress,
            amount: usdcAmount,
            assetIndex: Number(DEFAULT_USDC_ASSET),
            note: new TextEncoder().encode(`osc:sweep:usdc:${address}`),
            suggestedParams,
          });
        txns.push({
          leg: "usdc",
          unsignedTxnB64: Buffer.from(
            algosdk.encodeUnsignedTransaction(transaction),
          ).toString("base64"),
          amount: usdcAmount,
        });
      }
      if (algoLeg) {
        const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject(
          {
            sender: address,
            receiver: bonusAddress,
            amount: algoAmount,
            note: new TextEncoder().encode(`osc:sweep:algo:${address}`),
            suggestedParams,
          },
        );
        txns.push({
          leg: "algo",
          unsignedTxnB64: Buffer.from(
            algosdk.encodeUnsignedTransaction(transaction),
          ).toString("base64"),
          amount: algoAmount,
        });
      }
      return { receiver: bonusAddress, txns };
    },

    async submitSignedTransaction(
      signedTxnB64: string,
    ): Promise<SignedSubmitResult> {
      let optInAddress: string | null = null;
      let sweep: {
        readonly sender: string;
        readonly leg: "algo" | "usdc";
        readonly amount: number;
      } | null = null;
      try {
        const decoded = algosdk.decodeSignedTransaction(
          new Uint8Array(Buffer.from(signedTxnB64, "base64")),
        );
        const transfer = decoded.txn.assetTransfer;
        if (
          decoded.txn.type === "axfer" &&
          transfer !== undefined &&
          transfer.amount === 0n &&
          transfer.receiver.toString() === decoded.txn.sender.toString()
        ) {
          optInAddress = decoded.txn.sender.toString();
        } else if (
          decoded.txn.type === "axfer" &&
          transfer !== undefined &&
          transfer.receiver.toString() === bonusAddress
        ) {
          sweep = {
            sender: decoded.txn.sender.toString(),
            leg: "usdc",
            amount: Number(transfer.amount),
          };
        } else if (
          decoded.txn.type === "pay" &&
          decoded.txn.payment !== undefined &&
          decoded.txn.payment.receiver.toString() === bonusAddress
        ) {
          sweep = {
            sender: decoded.txn.sender.toString(),
            leg: "algo",
            amount: Number(decoded.txn.payment.amount),
          };
        }
      } catch {
        // The mock relay remains an opaque submit port for fault-injection
        // tests. Valid opt-ins additionally update account state so the
        // starter-stake watcher behaves like a chain observer.
      }
      const applyOptIn = (): void => {
        if (optInAddress === null) return;
        control.accountOverrides.set(optInAddress, {
          ...control.accountOverrides.get(optInAddress),
          exists: true,
          optedInUsdc: true,
        });
      };
      // Sweeps behave like a chain observer too: credit the bonus account and
      // debit the sender's overridden balances so the dev/e2e loop sees funds
      // actually move.
      const applySweep = (): void => {
        if (sweep === null) return;
        state.bonusBalances =
          sweep.leg === "usdc"
            ? {
                ...state.bonusBalances,
                usdcMicroUsdc: state.bonusBalances.usdcMicroUsdc + sweep.amount,
              }
            : {
                ...state.bonusBalances,
                algoMicroAlgo: state.bonusBalances.algoMicroAlgo + sweep.amount,
              };
        const override = control.balanceOverrides.get(sweep.sender);
        if (override !== undefined) {
          const clamp = (value: number): number => (value > 0 ? value : 0);
          control.balanceOverrides.set(sweep.sender, {
            ...override,
            ...(sweep.leg === "usdc"
              ? {
                  usdcMicroUsdc: clamp(
                    (override.usdcMicroUsdc ?? 0) - sweep.amount,
                  ),
                }
              : {
                  algoMicroAlgo: clamp(
                    (override.algoMicroAlgo ?? 0) - sweep.amount - 1_000,
                  ),
                }),
          });
        }
      };
      const value = await takeScripted(control.signedQueue);
      if (value !== undefined) {
        if (!value.ok) {
          if (value.reason === "unavailable" && value.applied === true) {
            const issued = allocateTx();
            confirm(issued.txid, issued.round);
            applyOptIn();
            applySweep();
          }
          return {
            ok: false,
            reason: value.reason,
            ...(value.detail === undefined ? {} : { detail: value.detail }),
          };
        }
      }
      const issued = allocateTx();
      confirm(issued.txid, issued.round);
      applyOptIn();
      applySweep();
      return { ok: true, txid: issued.txid };
    },

    async getBalances(address: string): Promise<Balances> {
      requireQuery("balances");
      const base =
        address === treasuryAddress
          ? state.balances
          : address === bonusAddress
            ? state.bonusBalances
            : { usdcMicroUsdc: 0, algoMicroAlgo: 0 };
      return { ...base, ...control.balanceOverrides.get(address) };
    },

    async getAccountInfo(address: string): Promise<AccountInfo> {
      requireQuery("account");
      return {
        exists: true,
        rekeyed: false,
        optedInUsdc: true,
        spendableAlgoMicro: 0,
        ...control.accountOverrides.get(address),
      };
    },

    async health(): Promise<boolean> {
      return control.healthy;
    },
  };

  return rail;
}
