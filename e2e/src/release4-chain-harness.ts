import {
  MAINNET_CAIP2,
  MAINNET_USDC_ASSET,
  TESTNET_CAIP2,
  TESTNET_USDC_ASSET,
} from "@onestepchess/agent-kit";
import type {
  DecodeResult,
  PaymentChallenge,
  PaymentRail,
  PreparedPayouts,
  TxStatus,
} from "@onestepchess/core";
import algosdk from "algosdk";
import { z } from "zod";

export const MAINNET_MICRO_SMOKE_LIMIT = 100_000;
export const MAINNET_ACKNOWLEDGEMENT =
  "I approve the one-time Release 4 mainnet micro-smoke up to 0.10 USDC";
export const RELEASE4_CHAIN_OPERATION_LIST = Object.freeze([
  "health",
  "balances_before",
  "challenge",
  "build_payment",
  "decode_payment",
  "verify_payment",
  "settle_payment",
  "confirm_payment",
  "balances_after_payment",
  "prepare_payout",
  "persist_prepared_identity",
  "submit_payout",
  "confirm_payout",
  "find_payout_note",
  "reconcile_balances",
] as const);

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

const liveEnvironmentSchema = z.object({
  OSC_LIVE_APPROVED: z.literal("yes"),
  OSC_LIVE_PROFILE: z.enum(["testnet", "mainnet"]),
  OSC_LIVE_EXPECT_NETWORK: z.enum(["testnet", "mainnet"]),
  OSC_LIVE_CAIP2: z.string().startsWith("algorand:"),
  OSC_LIVE_USDC_ASA_ID: positiveIntegerString,
  OSC_LIVE_ALGOD_URL: z.url(),
  OSC_LIVE_INDEXER_URL: z.url(),
  OSC_LIVE_FACILITATOR_URL: z.url(),
  OSC_LIVE_TREASURY_ADDRESS: z.string().min(1),
  OSC_LIVE_EXPECT_FEE_PAYER: z.string().min(1),
  OSC_LIVE_PAYER_ADDRESS: z.string().min(1),
  OSC_LIVE_TREASURY_MNEMONIC: z.string().min(1),
  OSC_LIVE_BONUS_MNEMONIC: z.string().min(1),
  OSC_LIVE_PAYER_MNEMONIC: z.string().min(1),
  OSC_LIVE_RESOURCE_URL: z.url(),
  OSC_LIVE_PAYMENT_MICRO_USDC: positiveIntegerString,
  OSC_LIVE_PAYOUT_MICRO_USDC: positiveIntegerString,
  OSC_LIVE_AGGREGATE_BUDGET_MICRO_USDC: positiveIntegerString,
  OSC_LIVE_EVIDENCE_PATH: z.string().min(1),
  OSC_LIVE_MAINNET_LOCK_PATH: z.string().min(1).optional(),
});

export type Release4LiveConfig = {
  readonly profile: "testnet" | "mainnet";
  readonly caip2: string;
  readonly usdcAsaId: number;
  readonly algodUrl: string;
  readonly indexerUrl: string;
  readonly facilitatorUrl: string;
  readonly treasuryAddress: string;
  readonly expectedFeePayer: string;
  readonly payerAddress: string;
  readonly treasuryMnemonic: string;
  readonly bonusMnemonic: string;
  readonly payerMnemonic: string;
  readonly resourceUrl: string;
  readonly paymentMicroUsdc: number;
  readonly payoutMicroUsdc: number;
  readonly aggregateBudgetMicroUsdc: number;
  readonly evidencePath: string;
  readonly mainnetLockPath?: string;
};

export type Release4LiveRuntime = {
  readonly commandProfile: "testnet" | "mainnet";
  readonly ci?: string;
  readonly stdinIsTty: boolean;
  readonly acknowledgement?: string;
  readonly evidenceExists: (path: string) => boolean;
};

export function authorizeRelease4LiveRun(
  source: Readonly<Record<string, string | undefined>>,
  runtime: Release4LiveRuntime,
): Release4LiveConfig {
  if (runtime.ci !== undefined) {
    throw new Error("Release 4 live chain commands are forbidden in CI");
  }
  const env = liveEnvironmentSchema.parse(source);
  if (env.OSC_LIVE_PROFILE !== runtime.commandProfile) {
    throw new Error("live command and configured profile disagree");
  }
  if (env.OSC_LIVE_PROFILE !== env.OSC_LIVE_EXPECT_NETWORK) {
    throw new Error("live profile and explicit network pin disagree");
  }
  const expected =
    env.OSC_LIVE_PROFILE === "testnet"
      ? { caip2: TESTNET_CAIP2, asset: Number(TESTNET_USDC_ASSET) }
      : { caip2: MAINNET_CAIP2, asset: Number(MAINNET_USDC_ASSET) };
  if (
    env.OSC_LIVE_CAIP2 !== expected.caip2 ||
    env.OSC_LIVE_USDC_ASA_ID !== expected.asset
  ) {
    throw new Error("live network or native-USDC pin is not canonical");
  }
  if (
    !algosdk.isValidAddress(env.OSC_LIVE_TREASURY_ADDRESS) ||
    !algosdk.isValidAddress(env.OSC_LIVE_EXPECT_FEE_PAYER) ||
    !algosdk.isValidAddress(env.OSC_LIVE_PAYER_ADDRESS)
  ) {
    throw new Error("live treasury and fee payer must be Algorand addresses");
  }
  const resource = new URL(env.OSC_LIVE_RESOURCE_URL);
  if (resource.search !== "" || resource.hash !== "") {
    throw new Error("live resource URL must be canonical");
  }
  const requested =
    env.OSC_LIVE_PAYMENT_MICRO_USDC + env.OSC_LIVE_PAYOUT_MICRO_USDC;
  if (requested > env.OSC_LIVE_AGGREGATE_BUDGET_MICRO_USDC) {
    throw new Error("live operations exceed the approved aggregate budget");
  }
  if (env.OSC_LIVE_PROFILE === "mainnet") {
    if (env.OSC_LIVE_AGGREGATE_BUDGET_MICRO_USDC > MAINNET_MICRO_SMOKE_LIMIT) {
      throw new Error("mainnet aggregate budget exceeds 0.10 USDC");
    }
    if (
      !runtime.stdinIsTty ||
      runtime.acknowledgement !== MAINNET_ACKNOWLEDGEMENT
    ) {
      throw new Error("mainnet smoke requires the interactive acknowledgement");
    }
    if (env.OSC_LIVE_MAINNET_LOCK_PATH === undefined) {
      throw new Error("mainnet smoke requires a one-time lock path");
    }
    if (runtime.evidenceExists(env.OSC_LIVE_MAINNET_LOCK_PATH)) {
      throw new Error("mainnet smoke lock already exists");
    }
  }
  if (runtime.evidenceExists(env.OSC_LIVE_EVIDENCE_PATH)) {
    throw new Error("live evidence destination already exists");
  }
  return {
    profile: env.OSC_LIVE_PROFILE,
    caip2: env.OSC_LIVE_CAIP2,
    usdcAsaId: env.OSC_LIVE_USDC_ASA_ID,
    algodUrl: env.OSC_LIVE_ALGOD_URL,
    indexerUrl: env.OSC_LIVE_INDEXER_URL,
    facilitatorUrl: env.OSC_LIVE_FACILITATOR_URL,
    treasuryAddress: env.OSC_LIVE_TREASURY_ADDRESS,
    expectedFeePayer: env.OSC_LIVE_EXPECT_FEE_PAYER,
    payerAddress: env.OSC_LIVE_PAYER_ADDRESS,
    treasuryMnemonic: env.OSC_LIVE_TREASURY_MNEMONIC,
    bonusMnemonic: env.OSC_LIVE_BONUS_MNEMONIC,
    payerMnemonic: env.OSC_LIVE_PAYER_MNEMONIC,
    resourceUrl: env.OSC_LIVE_RESOURCE_URL,
    paymentMicroUsdc: env.OSC_LIVE_PAYMENT_MICRO_USDC,
    payoutMicroUsdc: env.OSC_LIVE_PAYOUT_MICRO_USDC,
    aggregateBudgetMicroUsdc: env.OSC_LIVE_AGGREGATE_BUDGET_MICRO_USDC,
    evidencePath: env.OSC_LIVE_EVIDENCE_PATH,
    ...(env.OSC_LIVE_MAINNET_LOCK_PATH === undefined
      ? {}
      : { mainnetLockPath: env.OSC_LIVE_MAINNET_LOCK_PATH }),
  };
}

type ChainRail = Pick<
  PaymentRail,
  | "treasuryAddress"
  | "health"
  | "getBalances"
  | "buildPaymentChallenge"
  | "decodePayment"
  | "verify"
  | "settle"
  | "getTransactionStatus"
  | "preparePayouts"
  | "submitPrepared"
  | "findPayoutByNote"
>;

export type Release4ChainHarnessInput = {
  readonly profile: "testnet" | "mainnet";
  readonly caip2: string;
  readonly usdcAsaId: number;
  readonly treasuryAddress: string;
  readonly expectedFeePayer: string;
  readonly payerAddress: string;
  readonly resourceUrl: string;
  readonly paymentMicroUsdc: number;
  readonly payoutMicroUsdc: number;
  readonly payoutJobId: string;
};

export type Release4ChainEvidence = {
  readonly profile: "testnet" | "mainnet";
  readonly network: string;
  readonly paymentTxid: string;
  readonly paymentConfirmedRound: number;
  readonly payoutTxid: string;
  readonly payoutConfirmedRound: number;
  readonly payoutNoteTxid: string;
  readonly settleLatencyMs: number;
  readonly treasuryDeltaMicroUsdc: number;
  readonly operations: readonly string[];
};

export type Release4ChainHarnessDependencies = {
  readonly rail: ChainRail;
  readonly buildPaymentHeader: (challenge: PaymentChallenge) => Promise<string>;
  readonly record: (event: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
};

function assertChallenge(
  challenge: PaymentChallenge,
  input: Release4ChainHarnessInput,
): void {
  const requirement = challenge.required.accepts[0];
  if (
    challenge.required.accepts.length !== 1 ||
    requirement.scheme !== "exact" ||
    requirement.network !== input.caip2 ||
    requirement.asset !== String(input.usdcAsaId) ||
    requirement.amount !== String(input.paymentMicroUsdc) ||
    requirement.payTo !== input.treasuryAddress ||
    challenge.required.resource.url !== input.resourceUrl ||
    requirement.extra.feePayer !== input.expectedFeePayer ||
    requirement.extra.decimals !== 6
  ) {
    throw new Error("live payment challenge does not match the pinned profile");
  }
}

function assertDecoded(
  decoded: DecodeResult,
  input: Release4ChainHarnessInput,
): asserts decoded is Extract<DecodeResult, { readonly ok: true }> {
  if (
    !decoded.ok ||
    decoded.payment.sender !== input.payerAddress ||
    decoded.payment.amountMicroUsdc !== input.paymentMicroUsdc ||
    decoded.payment.asset !== String(input.usdcAsaId) ||
    decoded.payment.payTo !== input.treasuryAddress ||
    decoded.payment.lastValidRound === null
  ) {
    throw new Error("live signed payment failed the decoded transaction guard");
  }
}

async function confirmedRound(
  txid: string,
  rail: ChainRail,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status: TxStatus = await rail.getTransactionStatus(txid);
    if (status.status === "confirmed") return status.confirmedRound;
    await sleep(2_000);
  }
  throw new Error(`transaction confirmation timed out: ${txid}`);
}

function preparedEvidence(prepared: PreparedPayouts) {
  return {
    type: "payout_prepared",
    kind: prepared.kind,
    groupId: prepared.groupId,
    txids: prepared.txids,
    lastValidRound: prepared.lastValidRound,
  } as const;
}

export async function runRelease4ChainHarness(
  input: Release4ChainHarnessInput,
  dependencies: Release4ChainHarnessDependencies,
): Promise<Release4ChainEvidence> {
  const operations: string[] = [];
  const step = (name: string) => operations.push(name);
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const rail = dependencies.rail;
  if (rail.treasuryAddress !== input.treasuryAddress) {
    throw new Error("configured treasury mnemonic does not match the pin");
  }

  step("health");
  if (!(await rail.health()))
    throw new Error("configured facilitator unavailable");
  step("balances_before");
  const before = await rail.getBalances(input.treasuryAddress);
  step("challenge");
  const challenge = rail.buildPaymentChallenge({
    amountMicroUsdc: input.paymentMicroUsdc,
    resource: input.resourceUrl,
  });
  assertChallenge(challenge, input);
  step("build_payment");
  const paymentHeader = await dependencies.buildPaymentHeader(challenge);
  step("decode_payment");
  const decoded = rail.decodePayment(paymentHeader);
  assertDecoded(decoded, input);
  step("verify_payment");
  const verified = await rail.verify(paymentHeader, challenge.required);
  if (!verified.ok)
    throw new Error(`facilitator verify failed: ${verified.reason}`);
  step("settle_payment");
  const settleStarted = now();
  const settled = await rail.settle(paymentHeader, challenge.required);
  const settleLatencyMs = Math.max(0, now() - settleStarted);
  if (!settled.ok)
    throw new Error(`facilitator settle failed: ${settled.reason}`);
  step("confirm_payment");
  const paymentConfirmedRound = await confirmedRound(settled.txid, rail, sleep);
  step("balances_after_payment");
  const afterPayment = await rail.getBalances(input.treasuryAddress);
  if (
    afterPayment.usdcMicroUsdc - before.usdcMicroUsdc !==
    input.paymentMicroUsdc
  ) {
    throw new Error("treasury payment delta does not match the settled amount");
  }

  step("prepare_payout");
  const prepared = await rail.preparePayouts([
    {
      jobId: input.payoutJobId,
      recipient: input.payerAddress,
      amountMicroUsdc: input.payoutMicroUsdc,
    },
  ]);
  step("persist_prepared_identity");
  await dependencies.record(preparedEvidence(prepared));
  step("submit_payout");
  const submitted = await rail.submitPrepared(prepared);
  if (!submitted.ok)
    throw new Error(`payout submission failed: ${submitted.reason}`);
  const payoutTxid = prepared.txids[0]?.txid;
  if (payoutTxid === undefined) throw new Error("prepared payout omitted txid");
  step("confirm_payout");
  const payoutConfirmedRound = await confirmedRound(payoutTxid, rail, sleep);
  step("find_payout_note");
  const note = await rail.findPayoutByNote(input.payoutJobId);
  if (note === null || note.txid !== payoutTxid) {
    throw new Error("confirmed payout note was not indexed");
  }
  step("reconcile_balances");
  const final = await rail.getBalances(input.treasuryAddress);
  const expectedFinal =
    before.usdcMicroUsdc + input.paymentMicroUsdc - input.payoutMicroUsdc;
  if (final.usdcMicroUsdc !== expectedFinal) {
    throw new Error("live chain flow ended with unexplained treasury drift");
  }
  const evidence = {
    profile: input.profile,
    network: input.caip2,
    paymentTxid: settled.txid,
    paymentConfirmedRound,
    payoutTxid,
    payoutConfirmedRound,
    payoutNoteTxid: note.txid,
    settleLatencyMs,
    treasuryDeltaMicroUsdc: final.usdcMicroUsdc - before.usdcMicroUsdc,
    operations,
  } as const;
  await dependencies.record({ type: "release4_chain_complete", ...evidence });
  return evidence;
}
