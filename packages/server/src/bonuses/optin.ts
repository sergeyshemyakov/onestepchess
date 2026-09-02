import { setTimeout as sleep } from "node:timers/promises";
import type { PaymentRail } from "@onestepchess/core";
import algosdk from "algosdk";
import { type GenesisProfile, genesisForCaip2 } from "../auth/genesis.js";
import type { ServerConfig } from "../config.js";
import type { Coordinator } from "../coordinator/queue.js";

function canonicalBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.toString("base64") === value
    ? new Uint8Array(bytes)
    : null;
}

function empty(value: Uint8Array | undefined): boolean {
  return value === undefined || value.length === 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

/** Server-authoritative relay guard. It validates policy only; algod performs
 * signature verification when the exact bytes are relayed. */
export function isSafeBonusOptIn(
  signedTxnB64: string,
  player: string,
  config: ServerConfig,
): boolean {
  const bytes = canonicalBase64(signedTxnB64);
  if (bytes === null) return false;
  let decoded: algosdk.SignedTransaction;
  try {
    decoded = algosdk.decodeSignedTransaction(bytes);
  } catch {
    return false;
  }
  const txn = decoded.txn;
  const transfer = txn.assetTransfer;
  let genesis: GenesisProfile;
  try {
    genesis = genesisForCaip2(config.CAIP2);
  } catch {
    return false;
  }
  return (
    decoded.sig !== undefined &&
    decoded.msig === undefined &&
    decoded.lsig === undefined &&
    decoded.sgnr === undefined &&
    txn.type === "axfer" &&
    txn.sender.toString() === player &&
    transfer !== undefined &&
    transfer.receiver.toString() === player &&
    transfer.amount === 0n &&
    transfer.assetIndex === BigInt(config.USDC_ASA) &&
    transfer.assetSender === undefined &&
    transfer.closeRemainderTo === undefined &&
    txn.fee === 1_000n &&
    txn.firstValid <= txn.lastValid &&
    txn.lastValid <= txn.firstValid + 1_000n &&
    txn.genesisID === genesis.id &&
    txn.genesisHash !== undefined &&
    bytesEqual(
      txn.genesisHash,
      new Uint8Array(Buffer.from(genesis.hashB64, "base64")),
    ) &&
    txn.group === undefined &&
    empty(txn.lease) &&
    empty(txn.note) &&
    txn.rekeyTo === undefined
  );
}

export type OptInWatchDeps = {
  readonly coordinator: Coordinator;
  readonly rail: PaymentRail;
  readonly onFundingWork?: () => void;
};

export type OptInWatchInput = {
  readonly player: string;
  /** The exact guard-validated bytes the route relayed — safe to resubmit
   * because a duplicate lands as the same txid or bounces off algod. */
  readonly signedTxnB64: string;
  /** False when the route's relay attempt came back ambiguous ("unavailable"),
   * in which case the watch retries the retained bytes itself. */
  readonly relayed: boolean;
  readonly attempts: number;
  readonly intervalMs: number;
};

/** Route-facing wrapper around `watchRelayedOptIn`: one live watch per player.
 * `/my/bonus/optin` can be replayed with the same valid bytes while the row is
 * still `claimed`, and without coalescing each accepted POST would fan out its
 * own 30 s polling loop against algod. */
export function createOptInWatchLauncher(
  deps: OptInWatchDeps,
  options: {
    readonly attempts: number;
    readonly intervalMs: number;
    readonly onError?: (error: unknown, player: string) => void;
  },
): (
  input: Omit<OptInWatchInput, "attempts" | "intervalMs">,
) => Promise<boolean> {
  const watching = new Set<string>();
  return async (input) => {
    if (watching.has(input.player)) return false;
    watching.add(input.player);
    try {
      return await watchRelayedOptIn(deps, {
        ...input,
        attempts: options.attempts,
        intervalMs: options.intervalMs,
      });
    } catch (error) {
      options.onError?.(error, input.player);
      return false;
    } finally {
      watching.delete(input.player);
    }
  };
}

/** Fast-path observation after `POST /my/bonus/optin`: the opt-in confirms on
 * chain in seconds, so waiting for the 60 s bonus watcher makes every player
 * stare at "confirming…" for up to a minute. This bounded watch advances the
 * bonus the moment the account shows the opt-in and kicks the funding
 * executor; the periodic watcher stays the durable fallback, so giving up
 * here loses nothing. */
export async function watchRelayedOptIn(
  deps: OptInWatchDeps,
  input: OptInWatchInput,
): Promise<boolean> {
  let relayed = input.relayed;
  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    if (attempt > 0) await sleep(input.intervalMs);
    let optedIn = false;
    try {
      optedIn = (await deps.rail.getAccountInfo(input.player)).optedInUsdc;
    } catch {
      continue;
    }
    if (optedIn) {
      await deps.coordinator.dispatch({
        type: "FundingPendingAlgoSkipped",
        payload: { player: input.player },
        refIds: [input.player],
      });
      const result = await deps.coordinator.dispatch<
        { player: string },
        { changed: boolean }
      >({
        type: "BonusOptInObserved",
        payload: { player: input.player },
        refIds: [input.player],
      });
      if (result.kind === "ok" && result.result.changed) {
        deps.onFundingWork?.();
        return true;
      }
      return false;
    }
    if (!relayed) {
      try {
        const retried = await deps.rail.submitSignedTransaction(
          input.signedTxnB64,
        );
        // A rejection here can mean "already in the ledger" from the
        // ambiguous first attempt — either way the account poll above is the
        // arbiter, so retrying the bytes again would only hammer algod.
        if (retried.ok || retried.reason === "rejected") relayed = true;
      } catch {
        // Relay still unavailable — keep polling; the next pass retries.
      }
    }
  }
  return false;
}
