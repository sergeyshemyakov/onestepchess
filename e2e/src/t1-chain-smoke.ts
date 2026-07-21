import { open } from "node:fs/promises";
import { createAvmRail } from "@onestepchess/rail-avm";
import { ExactAvmScheme, toClientAvmSigner } from "@x402-avm/avm";
import algosdk from "algosdk";
import { z } from "zod";

const envSchema = z.object({
  OSC_CHAIN_SMOKE_APPROVED: z.literal("yes"),
  T1_CAIP2: z.string().startsWith("algorand:"),
  T1_USDC_ASA_ID: z.coerce.number().int().positive(),
  T1_ALGOD_URL: z.url(),
  T1_INDEXER_URL: z.url(),
  T1_FACILITATOR_URL: z.url(),
  T1_TREASURY_MNEMONIC: z.string().min(1),
  T1_PAYER_MNEMONIC: z.string().min(1),
  T1_RESOURCE_URL: z.url(),
  T1_PAYMENT_MICRO_USDC: z.coerce.number().int().positive(),
  T1_PAYOUT_MICRO_USDC: z.coerce.number().int().positive(),
  T1_ARTIFACT_PATH: z.string().min(1),
});

if (process.env.CI !== undefined) {
  throw new Error("T1 chain smoke is forbidden in CI");
}
const env = envSchema.parse(process.env);
const artifact = await open(env.T1_ARTIFACT_PATH, "wx", 0o600);

const payer = algosdk.mnemonicToSecretKey(env.T1_PAYER_MNEMONIC);
const rail = createAvmRail({
  caip2: env.T1_CAIP2,
  usdcAsaId: env.T1_USDC_ASA_ID,
  algodUrl: env.T1_ALGOD_URL,
  indexerUrl: env.T1_INDEXER_URL,
  facilitatorUrl: env.T1_FACILITATOR_URL,
  treasuryMnemonic: env.T1_TREASURY_MNEMONIC,
});

if (!(await rail.health()))
  throw new Error("configured facilitator kind unavailable");
const challenge = rail.buildPaymentChallenge({
  amountMicroUsdc: env.T1_PAYMENT_MICRO_USDC,
  resource: env.T1_RESOURCE_URL,
});
const requirement = challenge.required.accepts[0];
const signer = toClientAvmSigner(Buffer.from(payer.sk).toString("base64"));
const scheme = new ExactAvmScheme(signer, { algodUrl: env.T1_ALGOD_URL });
const built = await scheme.createPaymentPayload(
  2,
  requirement as Parameters<ExactAvmScheme["createPaymentPayload"]>[1],
);
const paymentPayload = {
  x402Version: 2 as const,
  resource: challenge.required.resource,
  accepted: requirement,
  payload: built.payload,
};
const paymentHeader = Buffer.from(
  JSON.stringify(paymentPayload),
  "utf8",
).toString("base64");
const decoded = rail.decodePayment(paymentHeader);
if (!decoded.ok) throw new Error("locally built exact payment did not decode");
const verified = await rail.verify(paymentHeader, challenge.required);
if (!verified.ok)
  throw new Error(`facilitator verify failed: ${verified.reason}`);

const settleStarted = performance.now();
const settled = await rail.settle(paymentHeader, challenge.required);
const settleLatencyMs = Math.round(performance.now() - settleStarted);
if (!settled.ok)
  throw new Error(`facilitator settle failed: ${settled.reason}`);

async function waitForConfirmation(txid: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await rail.getTransactionStatus(txid);
    if (status.status === "confirmed") return status.confirmedRound;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`transaction confirmation timed out: ${txid}`);
}

const paymentConfirmedRound = await waitForConfirmation(settled.txid);
const payout = await rail.preparePayouts([
  {
    jobId: `t1-${Date.now()}`,
    recipient: payer.addr.toString(),
    amountMicroUsdc: env.T1_PAYOUT_MICRO_USDC,
  },
]);
await artifact.writeFile(
  `${JSON.stringify({ challenge: challenge.required, payout }, null, 2)}\n`,
  { encoding: "utf8" },
);
await artifact.sync();
await artifact.close();
const submitted = await rail.submitPrepared(payout);
if (!submitted.ok)
  throw new Error(`payout submission failed: ${submitted.reason}`);
const payoutConfirmedRound = await waitForConfirmation(
  payout.txids[0]?.txid ?? "",
);
const noteResult = await rail.findPayoutByNote(payout.txids[0]?.jobId ?? "");
if (noteResult === null)
  throw new Error("confirmed payout note was not indexed");

process.stdout.write(
  `${JSON.stringify({
    network: env.T1_CAIP2,
    paymentTxid: settled.txid,
    paymentConfirmedRound,
    payoutTxid: payout.txids[0]?.txid,
    payoutConfirmedRound,
    payoutNoteResult: noteResult,
    settleLatencyMs,
    d3SessionObservation:
      "verify and settle completed as independent V2 HTTP requests; no session identifier was required",
    artifactPath: env.T1_ARTIFACT_PATH,
  })}\n`,
);
