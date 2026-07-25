import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import algosdk from "algosdk";
import { z } from "zod";
import type { Signer } from "./auth.js";
import { OscClientError } from "./errors.js";

const keyfileSchema = z.object({
  addr: z.string(),
  mnemonic: z.string(),
  createdAt: z.string(),
});

export const FUNDING_CHECKLIST = Object.freeze([
  "Send about 0.25 ALGO to the address for the account minimum balance, USDC opt-in, and one transaction fee.",
  "Run optin_usdc and wait for confirmation.",
  "Only after opt-in, send native USDC on Algorand using the asset id reported by /meta (wrapped or bridged USDC is a different asset); 1–5 USDC is normally plenty.",
  "Funding routes: withdraw native Algorand USDC from a supporting exchange, send from Pera, or buy/swap in Pera and forward.",
]);

export function createKeyfile(path: string): {
  readonly address: string;
  readonly fundingChecklist: readonly string[];
} {
  const account = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  try {
    writeFileSync(
      path,
      `${JSON.stringify({
        addr: account.addr.toString(),
        mnemonic,
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(path, 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new OscClientError(
        "KEYFILE_EXISTS",
        `refusing to overwrite the existing wallet at ${path}`,
      );
    }
    throw error;
  }
  return {
    address: account.addr.toString(),
    fundingChecklist: FUNDING_CHECKLIST,
  };
}

export function loadSigner(
  options: { readonly keyfile?: string; readonly mnemonic?: string } = {},
): Signer {
  let mnemonic: string;
  if (options.mnemonic !== undefined) {
    mnemonic = options.mnemonic;
  } else {
    if (options.keyfile === undefined) {
      throw new OscClientError(
        "NO_WALLET",
        "no keyfile or OSC_MNEMONIC was provided",
      );
    }
    let parsed: z.infer<typeof keyfileSchema>;
    try {
      parsed = keyfileSchema.parse(
        JSON.parse(readFileSync(options.keyfile, "utf8")),
      );
    } catch {
      throw new OscClientError(
        "NO_WALLET",
        `could not load a valid wallet from ${options.keyfile}`,
      );
    }
    mnemonic = parsed.mnemonic;
  }

  let account: algosdk.Account;
  try {
    account = algosdk.mnemonicToSecretKey(mnemonic);
  } catch {
    throw new OscClientError("NO_WALLET", "wallet credentials are invalid");
  }
  const secretKey = account.sk;
  return Object.freeze({
    address: account.addr.toString(),
    sign(bytes: Uint8Array): Uint8Array {
      let transaction: algosdk.Transaction;
      try {
        transaction = algosdk.decodeUnsignedTransaction(bytes);
      } catch {
        throw new OscClientError(
          "NETWORK_MISMATCH",
          "refusing to sign undecodable transaction bytes",
        );
      }
      return transaction.signTxn(secretKey);
    },
  });
}
