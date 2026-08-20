import type { MicroUsdc } from "../types.js";

/** Thrown only for caller-contract violations and rail-internal invariants —
 * never for expected chain/facilitator outcomes (those are in-band). */
export class RailError extends Error {
  constructor(
    readonly code: "CONTRACT" | "NOT_READY" | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "RailError";
  }
}

export type StakeQuote = {
  readonly amountMicroUsdc: MicroUsdc; // claim.stake_microusdc, > 0
  readonly resource: string; // absolute URL of the stable move endpoint
};

export type PaymentRequirements = {
  readonly scheme: string; // 'exact' (avm) | 'mock' (rail-mock)
  readonly network: string; // CAIP-2; 'mock:local' for rail-mock
  readonly asset: string; // ASA id as string ('31566704' mainnet USDC)
  readonly amount: string; // atomic units (µUSDC), stringified integer
  readonly payTo: string; // treasury address
  readonly maxTimeoutSeconds: number;
  readonly extra: Readonly<Record<string, unknown>>;
};
export type PaymentRequired = {
  readonly x402Version: 2;
  readonly resource: {
    readonly url: string;
    readonly description?: string;
    readonly mimeType?: string;
  };
  readonly accepts: readonly [PaymentRequirements]; // exactly one rail in v1
  readonly extensions: Readonly<Record<string, unknown>>;
};
export type PaymentChallenge = {
  readonly required: PaymentRequired;
  readonly header: string; // encoded PAYMENT-REQUIRED value
};

export type DecodedPayment = {
  readonly clientTxId: string; // idempotency anchor (payment_intents.client_txid)
  readonly sender: string; // client-leg sender — the F4 binding check
  readonly amountMicroUsdc: MicroUsdc;
  readonly asset: string;
  readonly payTo: string; // client-leg receiver
  readonly lastValidRound: number | null; // null when not applicable (mock)
};
export type DecodeResult =
  | { readonly ok: true; readonly payment: DecodedPayment }
  | { readonly ok: false; readonly reason: "malformed" };

export type VerifyFailure =
  | "insufficient_funds"
  | "not_opted_in"
  | "invalid_payment"
  | "unavailable";
export type VerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: VerifyFailure;
      readonly detail?: string;
    };

export type SettleResult =
  | {
      readonly ok: true;
      readonly txid: string;
      readonly confirmedRound: number | null;
      readonly paymentResponseHeader: string;
    }
  | {
      readonly ok: false;
      readonly reason: "rejected" | "expired" | "unavailable";
      readonly detail?: string;
    };

export type PayoutInstruction = {
  readonly jobId: string; // payout_jobs.id → note 'osc:payout:{jobId}'
  readonly recipient: string;
  readonly amountMicroUsdc: MicroUsdc;
};

export type FundingInstruction = {
  readonly player: string; // recipient; note 'osc:bonus:{leg}:{player}'; sender is bonusAddress
  readonly leg: "algo" | "usdc";
  readonly amount: number; // µALGO (algo leg) | µUSDC (usdc leg), > 0
};
export type SendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "rejected" | "unavailable";
      readonly detail?: string;
    };
export type SignedSubmitResult =
  | { readonly ok: true; readonly txid: string }
  | {
      readonly ok: false;
      readonly reason: "rejected" | "unavailable";
      readonly detail?: string;
    };

/** Server-signed bytes (treasury for payouts, bonus account for funding) are
 * safe to persist; the secret keys are not. Persist this value and its txids
 * before calling submitPrepared(). */
export type PreparedPayouts = {
  readonly kind: "payouts";
  readonly payloadB64: string; // opaque signed atomic group
  readonly groupId: string;
  readonly txids: readonly { readonly jobId: string; readonly txid: string }[];
  readonly lastValidRound: number;
};
export type PreparedFunding = {
  readonly kind: "funding";
  readonly payloadB64: string; // opaque signed single transaction
  readonly player: string;
  readonly leg: "algo" | "usdc";
  readonly txid: string;
  readonly lastValidRound: number;
};
export type PreparedSubmission = PreparedPayouts | PreparedFunding;

export type SweepTxn = {
  readonly leg: "algo" | "usdc";
  readonly unsignedTxnB64: string; // base64 msgpack, guarded params (§6.4)
  readonly amount: number; // µALGO (algo leg) | µUSDC (usdc leg), > 0
};
/** A welcome-bonus return quote: the player signs these and the server relays
 * them. `txns` is empty when nothing can be returned (no funds, or the
 * spendable ALGO cannot even cover the flat fees). */
export type SweepQuote = {
  readonly receiver: string; // bonusAddress — the only allowed destination
  readonly txns: readonly SweepTxn[];
};

export type TxStatus =
  | { readonly status: "confirmed"; readonly confirmedRound: number }
  | { readonly status: "pending" }
  | {
      readonly status: "not_found";
      readonly currentRound: number;
    };

export interface PaymentRail {
  /** Stakes in, payouts out. Never funds welcome bonuses. */
  readonly treasuryAddress: string;
  /** Dedicated welcome-bonus account — the sender of every funding leg, so
   * bonus spend can never eat into stake/refund money held by the treasury. */
  readonly bonusAddress: string;

  /** Sync. rail-avm reads the feePayer cache fed by health() and throws
   * RailError('NOT_READY') before the first successful health();
   * implementations without a warm-up (rail-mock) are always ready. */
  buildPaymentChallenge(quote: StakeQuote): PaymentChallenge;

  /** Pure parse of a PAYMENT-SIGNATURE header — no I/O, no signature check
   * (signatures are the facilitator's job). Supersedes clientTxId(). */
  decodePayment(header: string): DecodeResult;

  verify(header: string, required: PaymentRequired): Promise<VerifyResult>;
  settle(header: string, required: PaymentRequired): Promise<SettleResult>;
  /** Deterministically rebuild PAYMENT-RESPONSE after crash recovery. */
  encodePaymentResponse(txid: string): string;

  /** Preparation may query suggested params and signs locally but never
   * broadcasts. The server persists the returned bytes/txids first. */
  preparePayouts(batch: readonly PayoutInstruction[]): Promise<PreparedPayouts>;
  prepareFunding(instr: FundingInstruction): Promise<PreparedFunding>;

  /** Broadcast these exact persisted bytes once. Replaying the exact payload
   * is idempotent at the transaction-id level. */
  submitPrepared(prepared: PreparedSubmission): Promise<SendResult>;

  getTransactionStatus(txid: string): Promise<TxStatus>;
  findPayoutByNote(jobId: string): Promise<{
    readonly txid: string;
    readonly confirmedRound: number;
  } | null>;

  findFundingByNote(
    player: string,
    leg: "algo" | "usdc",
  ): Promise<{
    readonly txid: string;
    readonly confirmedRound: number;
  } | null>;

  /** (2026-07-14, server F14) Unsigned zero-amount USDC self-transfer (the
   * ASA opt-in) for `address`, guarded params (§6.4), base64 msgpack. */
  buildOptInTxn(address: string): Promise<string>;
  /** (2026-07-14, server F14) Relay of a client-signed opt-in transaction;
   * this flow has no browser-to-algod call. In-band failures like the dance ops. */
  submitSignedTransaction(signedTxnB64: string): Promise<SignedSubmitResult>;

  /** (2026-08-12, welcome-bonus return) Unsigned transactions that sweep the
   * player's full USDC holding plus all spendable ALGO (amount − min-balance,
   * net of the flat fees) back to `bonusAddress`. Never closes the USDC
   * opt-in — a returning player can be re-funded without a new opt-in. The
   * player signs; relay goes through submitSignedTransaction, USDC leg first. */
  buildSweepTxns(address: string): Promise<SweepQuote>;

  getBalances(address: string): Promise<{
    readonly usdcMicroUsdc: MicroUsdc;
    readonly algoMicroAlgo: number;
  }>;
  getAccountInfo(address: string): Promise<{
    readonly exists: boolean;
    readonly rekeyed: boolean;
    readonly optedInUsdc: boolean;
    readonly spendableAlgoMicro: number; // amount − min-balance
  }>;

  /** Fetches /supported, refreshes the feePayer cache, returns true iff the
   * configured network + scheme (+ feePayer signer) are served. Doubles as
   * the refresh — the server's 60 s probe keeps the cache warm (CA-R7). */
  health(): Promise<boolean>;
}
