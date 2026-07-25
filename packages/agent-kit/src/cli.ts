#!/usr/bin/env node

import { existsSync } from "node:fs";
import { BudgetGuard } from "./budget.js";
import { createOscClient } from "./client.js";
import { loadEnv } from "./env.js";
import { createKeyfile, FUNDING_CHECKLIST, loadSigner } from "./keyfile.js";
import { optInUsdc, walletStatus } from "./wallet.js";

export type CliDependencies = {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly stdout?: { write(text: string): unknown };
  readonly stderr?: { write(text: string): unknown };
};

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function runCli(
  args: readonly string[],
  sourceEnv: Record<string, string | undefined> = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    const env = loadEnv(sourceEnv);
    const budget = new BudgetGuard({
      maxStakeMicroUsdc: env.maxStakeMicroUsdc,
      sessionBudgetMicroUsdc: env.sessionBudgetMicroUsdc,
    });
    if (!existsSync(env.keyfile) && env.mnemonic === undefined) {
      if (args[0] !== "onboard") {
        stderr.write(
          "NO_WALLET: run `npx @onestepchess/agent-kit onboard` or set OSC_MNEMONIC\n",
        );
        return 1;
      }
      createKeyfile(env.keyfile);
    }
    const signer = loadSigner({
      keyfile: env.keyfile,
      ...(env.mnemonic === undefined ? {} : { mnemonic: env.mnemonic }),
    });
    const client = createOscClient({
      serverUrl: env.serverUrl,
      signer,
      budget,
      ...(env.nickname === undefined ? {} : { nickname: env.nickname }),
      ...(env.expectNetwork === undefined
        ? {}
        : { expectNetwork: env.expectNetwork }),
      ...(env.algodUrl === undefined ? {} : { algodUrl: env.algodUrl }),
      ...(env.boardDir === undefined ? {} : { boardDir: env.boardDir }),
      ...(dependencies.fetch === undefined
        ? {}
        : { fetch: dependencies.fetch }),
    });
    const meta = await client.meta();
    const walletDependencies = {
      ...(env.algodUrl === undefined ? {} : { algodUrl: env.algodUrl }),
      ...(dependencies.fetch === undefined
        ? {}
        : { fetch: dependencies.fetch }),
    };

    if (args[0] === "status") {
      const [status, profile] = await Promise.all([
        walletStatus(signer, meta, walletDependencies),
        client.whoami(),
      ]);
      stdout.write(
        `${JSON.stringify({
          wallet: status,
          profile,
          remainingSessionBudgetMicroUsdc: budget.remaining(),
        })}\n`,
      );
      return 0;
    }

    if (args[0] !== "onboard") {
      stderr.write("usage: osc-agent <onboard|status>\n");
      return 1;
    }

    const profile = await client.register(env.nickname);
    stdout.write(`Wallet address: ${signer.address}\n`);
    for (const step of FUNDING_CHECKLIST) stdout.write(`- ${step}\n`);
    const sleep = dependencies.sleep ?? defaultSleep;

    while (true) {
      const status = await walletStatus(signer, meta, walletDependencies);
      if (status.ready) {
        stdout.write(
          `Ready as ${profile.nickname ?? profile.address}. Try: npx @onestepchess/mcp\n`,
        );
        return 0;
      }
      if (status.missing === "optin") {
        await optInUsdc(signer, meta, walletDependencies);
        continue;
      }
      stdout.write(`Waiting for ${status.missing} at ${signer.address}\n`);
      await sleep(10_000);
    }
  } catch (error) {
    const hint =
      error instanceof Error &&
      "hint" in error &&
      typeof error.hint === "string"
        ? error.hint
        : error instanceof Error
          ? error.message
          : "unknown failure";
    stderr.write(`${hint}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined) {
  const invoked = new URL(`file://${process.argv[1]}`).href;
  if (import.meta.url === invoked) {
    process.exitCode = await runCli(process.argv.slice(2));
  }
}
