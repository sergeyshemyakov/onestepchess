import { existsSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  assertTrustedPayment,
  buildPaymentHeader,
  type Meta,
  paymentRequiredSchema,
} from "@onestepchess/agent-kit";
import { createAvmRail } from "@onestepchess/rail-avm";
import algosdk from "algosdk";
import {
  authorizeRelease4LiveRun,
  MAINNET_ACKNOWLEDGEMENT,
  runRelease4ChainHarness,
} from "./release4-chain-harness.js";

async function main(): Promise<void> {
  if (process.env.CI !== undefined) {
    throw new Error("Release 4 live chain commands are forbidden in CI");
  }
  const commandProfile = process.argv[2];
  if (commandProfile !== "testnet" && commandProfile !== "mainnet") {
    throw new Error("Release 4 live chain command requires a pinned profile");
  }
  if (process.env.OSC_LIVE_PROFILE !== commandProfile) {
    throw new Error("live command and configured profile disagree");
  }
  let acknowledgement: string | undefined;
  if (commandProfile === "mainnet") {
    if (!process.stdin.isTTY) {
      throw new Error("mainnet smoke requires an interactive terminal");
    }
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      acknowledgement = await prompt.question(
        `Type this exact acknowledgement:\n${MAINNET_ACKNOWLEDGEMENT}\n> `,
      );
    } finally {
      prompt.close();
    }
  }
  const config = authorizeRelease4LiveRun(process.env, {
    commandProfile,
    ci: process.env.CI,
    stdinIsTty: process.stdin.isTTY === true,
    ...(acknowledgement === undefined ? {} : { acknowledgement }),
    evidenceExists: existsSync,
  });

  let lock: FileHandle | undefined;
  let evidence: FileHandle | undefined;
  try {
    if (config.mainnetLockPath !== undefined) {
      lock = await open(config.mainnetLockPath, "wx", 0o600);
      await lock.writeFile(
        `${JSON.stringify({
          profile: config.profile,
          approvedBudgetMicroUsdc: config.aggregateBudgetMicroUsdc,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      await lock.sync();
    }
    evidence = await open(config.evidencePath, "wx", 0o600);
    const record = async (event: Readonly<Record<string, unknown>>) => {
      if (evidence === undefined) throw new Error("evidence file is not open");
      await evidence.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      await evidence.sync();
    };
    await record({
      type: "release4_chain_start",
      profile: config.profile,
      network: config.caip2,
      usdcAsaId: config.usdcAsaId,
      treasuryAddress: config.treasuryAddress,
      payerAddress: config.payerAddress,
      resourceUrl: config.resourceUrl,
      approvedBudgetMicroUsdc: config.aggregateBudgetMicroUsdc,
    });

    const payer = algosdk.mnemonicToSecretKey(config.payerMnemonic);
    if (payer.addr.toString() !== config.payerAddress) {
      throw new Error(
        "payer mnemonic does not match the pinned public address",
      );
    }
    const rail = createAvmRail({
      caip2: config.caip2,
      usdcAsaId: config.usdcAsaId,
      algodUrl: config.algodUrl,
      indexerUrl: config.indexerUrl,
      facilitatorUrl: config.facilitatorUrl,
      treasuryMnemonic: config.treasuryMnemonic,
      bonusMnemonic: config.bonusMnemonic,
    });
    const meta: Meta = {
      name: "One Step Chess",
      network: {
        caip2: config.caip2,
        usdcAssetId: String(config.usdcAsaId),
        treasuryAddress: config.treasuryAddress,
        facilitatorUrl: config.facilitatorUrl,
        explorerBaseUrl: "https://explorer.perawallet.app",
        algodUrl: config.algodUrl,
      },
      economics: {
        humanStakeMicroUsdc: config.paymentMicroUsdc,
        agentStakeMicroUsdc: config.paymentMicroUsdc,
        endspielStakeMicroUsdc: config.paymentMicroUsdc,
        drawFeeMicroUsdc: 0,
        protocolFeeBps: 0,
        humanTargetMult: 1,
      },
      timing: {
        claimTtlSeconds: { human: 180, agent: 90, endspiel: 45 },
        timerRevealSeconds: 30,
        minPlyIntervalSeconds: 1,
        cooldownPlies: 1,
        nextGameNudgeSeconds: 10,
      },
      quotas: { human: 1, agent: 1, demo: 0, windowMinutes: 60 },
      status: { mode: "running", banner: null },
      turnstileSiteKey: "",
      rules: "Release 4 live chain smoke",
      docs: {
        llms: new URL("/llms.txt", config.resourceUrl).href,
        openapi: new URL("/api/v1/openapi.json", config.resourceUrl).href,
        mcpPackage: "@onestepchess/mcp",
        agentKitPackage: "@onestepchess/agent-kit",
        repo: "https://github.com/sergeyshemyakov/onestepchess",
      },
    };
    const signer = {
      address: config.payerAddress,
      sign(bytes: Uint8Array) {
        return algosdk.decodeUnsignedTransaction(bytes).signTxn(payer.sk);
      },
    };
    const report = await runRelease4ChainHarness(
      {
        profile: config.profile,
        caip2: config.caip2,
        usdcAsaId: config.usdcAsaId,
        treasuryAddress: config.treasuryAddress,
        expectedFeePayer: config.expectedFeePayer,
        payerAddress: config.payerAddress,
        resourceUrl: config.resourceUrl,
        paymentMicroUsdc: config.paymentMicroUsdc,
        payoutMicroUsdc: config.payoutMicroUsdc,
        payoutJobId: `release4-${config.profile}-${Date.now()}`,
      },
      {
        rail,
        record,
        async buildPaymentHeader(challenge) {
          const paymentRequired = paymentRequiredSchema.parse(
            challenge.required,
          );
          const claim = {
            claimId: "release4-live-smoke",
            yourSide: "white" as const,
            phase: "normal" as const,
            demo: false,
            fen: "8/8/8/8/8/8/4K3/7k w - - 0 1",
            legalMoves: [{ uci: "e2e3", san: "Ke3" }],
            stakeMicroUsdc: config.paymentMicroUsdc,
            deadline: new Date(Date.now() + 90_000).toISOString(),
          };
          const requirement = assertTrustedPayment({
            paymentRequired,
            claim,
            meta,
            resourceUrl: config.resourceUrl,
            expectNetwork: config.profile,
          });
          return buildPaymentHeader({
            paymentRequired,
            requirement,
            signer,
            algodUrl: config.algodUrl,
          });
        },
      },
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await evidence?.close();
    await lock?.close();
  }
}

try {
  await main();
} catch {
  process.stderr.write(
    "Release 4 live chain smoke refused or failed; inspect the sanitized evidence file if one was created.\n",
  );
  process.exitCode = 1;
}
