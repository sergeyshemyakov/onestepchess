import { useCallback, useState } from "react";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/http.js";
import type { Meta, ProfileView } from "../api/schemas.js";
import { AlgorandMark, KnightMark } from "../board/pieces.jsx";
import {
  acknowledgeStarterStake,
  starterStakeAcknowledged,
} from "../lib/storage.js";
import type { ConnectedWallet } from "../wallet/provider.js";

function errorHint(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.envelope.hint : fallback;
}

const STAGES = ["CLAIM", "ALGO", "USDC", "PLAY"] as const;

export function StarterStakeBanner(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly profile: ProfileView;
  readonly getWallet: () => Promise<ConnectedWallet>;
  readonly onRefresh: () => void;
}) {
  const status = props.profile.bonus?.status;
  const [busy, setBusy] = useState<"claim" | "optin" | null>(null);
  const [waitingForStatus, setWaitingForStatus] = useState<
    NonNullable<ProfileView["bonus"]>["status"] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(starterStakeAcknowledged);
  const paused = props.meta.status.mode === "paused";
  const waiting = waitingForStatus === status;

  const claim = useCallback(async () => {
    if (busy !== null) return;
    setBusy("claim");
    setError(null);
    try {
      await props.client.claimBonus();
      setWaitingForStatus("available");
      props.onRefresh();
    } catch (cause) {
      setError(errorHint(cause, "starter stake unavailable — try again"));
    } finally {
      setBusy(null);
    }
  }, [busy, props]);

  const optIn = useCallback(async () => {
    if (busy !== null) return;
    setBusy("optin");
    setWaitingForStatus(null);
    setError(null);
    try {
      const { submitStarterStakeOptIn } = await import("../wallet/optin.js");
      await submitStarterStakeOptIn({
        client: props.client,
        address: props.profile.address,
        meta: props.meta,
        getWallet: props.getWallet,
      });
      setWaitingForStatus("claimed");
      props.onRefresh();
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        return;
      }
      setError(
        errorHint(cause, "USDC setup did not complete — fetch a fresh try"),
      );
    } finally {
      setBusy(null);
    }
  }, [busy, props]);

  if (
    props.profile.kind !== "human" ||
    status === undefined ||
    (status === "funded" && (acknowledged || starterStakeAcknowledged()))
  ) {
    return null;
  }

  const activeStage =
    status === "available"
      ? 0
      : status === "claimed"
        ? 1
        : status === "opted_in"
          ? 2
          : 3;

  return (
    <section className="starter-stake" aria-label="starter stake">
      <div className="starter-stake-mascot" aria-hidden="true">
        <KnightMark size={38} />
        <AlgorandMark size={24} />
      </div>
      <div className="starter-stake-body">
        <h2 className="starter-stake-title">YOUR FIRST 20 MOVES ARE ON US</h2>
        <ol className="starter-stake-rail" aria-label="starter stake progress">
          {STAGES.map((stage, index) => (
            <li
              key={stage}
              className={index <= activeStage ? "done" : undefined}
              aria-current={index === activeStage ? "step" : undefined}
            >
              {stage}
            </li>
          ))}
        </ol>
        {status === "available" ? (
          <p className="starter-stake-copy">
            claim your one-time starter stake.
          </p>
        ) : status === "claimed" ? (
          <p className="starter-stake-copy">
            a little ALGO is on its way — then enable USDC.
          </p>
        ) : status === "opted_in" ? (
          <p className="starter-stake-copy">
            USDC enabled — sending your starter stake…
          </p>
        ) : (
          <p className="starter-stake-copy">
            starter stake ready — PLAY when you are.
          </p>
        )}
        {waiting ? (
          <p className="console" role="status">
            &gt; confirming on chain…
          </p>
        ) : null}
        {error === null ? null : (
          <p className="formerr" role="alert">
            {error}
          </p>
        )}
        {status === "available" ? (
          <button
            type="button"
            className="btn pri mini"
            disabled={busy !== null || paused || waiting}
            onClick={claim}
          >
            {busy === "claim" ? "claiming…" : "CLAIM ▸"}
          </button>
        ) : status === "claimed" ? (
          <button
            type="button"
            className="btn pri mini"
            disabled={busy !== null || paused || waiting}
            onClick={optIn}
          >
            {busy === "optin" ? "opening wallet…" : "ENABLE USDC ▸"}
          </button>
        ) : status === "funded" ? (
          <button
            type="button"
            className="btn pri mini"
            onClick={() => {
              acknowledgeStarterStake();
              setAcknowledged(true);
            }}
          >
            PLAY ▸
          </button>
        ) : null}
      </div>
    </section>
  );
}
