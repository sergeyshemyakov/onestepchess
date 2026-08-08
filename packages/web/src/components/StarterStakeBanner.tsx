import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/http.js";
import type { Meta, ProfileView } from "../api/schemas.js";
import { AlgorandMark, KnightMark } from "../board/pieces.jsx";
import { explorerTxUrl } from "../lib/explorer.js";
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
  const [completionRevealed, setCompletionRevealed] = useState(
    status === "funded",
  );
  const paused = props.meta.status.mode === "paused";
  const waiting = waitingForStatus === status;
  const visibleStatus =
    status === "funded" && !completionRevealed ? "opted_in" : status;

  // The SSE bonus_updated event is the fast path; a missed event must not
  // strand the banner mid-flow, so poll while a chain transition is pending
  // (opt-in confirmation, queued ALGO transfer, or USDC funding in flight).
  const bonus = props.profile.bonus;
  const awaitingChain =
    props.profile.kind === "human" &&
    status !== undefined &&
    (waiting ||
      status === "opted_in" ||
      (status === "claimed" &&
        bonus?.algoTxid === undefined &&
        bonus?.algoReady !== true));
  const { onRefresh } = props;
  useEffect(() => {
    if (!awaitingChain) return;
    const interval = setInterval(onRefresh, 5_000);
    return () => clearInterval(interval);
  }, [awaitingChain, onRefresh]);

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
    visibleStatus === "available"
      ? 0
      : visibleStatus === "claimed"
        ? 1
        : visibleStatus === "opted_in"
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
        {visibleStatus === "available" ? (
          <p className="starter-stake-copy">
            claim your one-time starter stake.
          </p>
        ) : visibleStatus === "claimed" ? (
          props.profile.bonus?.algoTxid === undefined ? (
            props.profile.bonus?.algoReady === true ? (
              <p className="starter-stake-copy">
                ALGO already available — enable USDC when you're ready.
              </p>
            ) : (
              <p className="starter-stake-copy">
                ALGO transfer queued — enable USDC after it arrives.
              </p>
            )
          ) : (
            <p className="starter-stake-copy">
              ALGO arrived — enable USDC.{" "}
              <a
                href={explorerTxUrl(
                  props.meta.network.explorerBaseUrl,
                  props.profile.bonus.algoTxid,
                )}
                target="_blank"
                rel="noreferrer"
              >
                tx ↗
              </a>
            </p>
          )
        ) : visibleStatus === "opted_in" ? (
          status === "funded" ? (
            <p className="starter-stake-copy">
              USDC arrived — continue when you're ready.
            </p>
          ) : (
            <p className="starter-stake-copy">
              USDC enabled — sending your starter stake…
            </p>
          )
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
        {visibleStatus === "available" ? (
          <button
            type="button"
            className="btn pri mini"
            disabled={busy !== null || paused || waiting}
            onClick={claim}
          >
            {busy === "claim" ? "claiming…" : "CLAIM ▸"}
          </button>
        ) : visibleStatus === "claimed" ? (
          <button
            type="button"
            className="btn pri mini"
            disabled={busy !== null || paused || waiting}
            onClick={optIn}
          >
            {busy === "optin" ? "opening wallet…" : "ENABLE USDC ▸"}
          </button>
        ) : status === "funded" && !completionRevealed ? (
          <button
            type="button"
            className="btn pri mini"
            onClick={() => setCompletionRevealed(true)}
          >
            CONTINUE ▸
          </button>
        ) : visibleStatus === "funded" ? (
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
