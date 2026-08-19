import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ApiClient } from "../api/client.js";
import type {
  FinishedGameItem,
  GamesPage,
  Meta,
  OngoingGameItem,
  PlayerView,
} from "../api/schemas.js";
import { BoardLoop } from "../board/BoardLoop.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { GamePane } from "../components/GamePane.jsx";
import { PlayerStatus } from "../components/PlayerStatus.jsx";
import { PromoStrip } from "../components/PromoStrip.jsx";
import { ShareSheet } from "../components/ShareSheet.jsx";
import { StarterStakeBanner } from "../components/StarterStakeBanner.jsx";
import {
  finishedMovesLabel,
  isFinishedStakedItem,
  ownedPlies,
  replayPath,
} from "../games/items.js";
import {
  outcomeFor,
  outcomeGlyph,
  repetitionAdjudicationNotice,
} from "../games/outcome.js";
import { payoutChip } from "../games/QuickView.jsx";
import { explorerTxUrl } from "../lib/explorer.js";
import { parseUci } from "../lib/fen.js";
import {
  formatCents,
  formatElapsedTime,
  formatGameDuration,
  formatGameLabel,
  formatLocalTime,
  formatMicroUsdc,
} from "../lib/format.js";
import {
  readLastSeenFinishedAt,
  writeLastSeenFinishedAt,
} from "../lib/storage.js";
import { useLive } from "../live/LiveContext.jsx";
import { PlayView } from "../play/PlayView.jsx";
import { usePlayFlow } from "../play/usePlayFlow.js";
import { CachedDigest } from "../replay/CachedDigest.jsx";
import { loadWalletModule } from "../wallet/lazy.js";
import { PaymentWalletSheet } from "../wallet/PaymentWalletSheet.jsx";
import type { ConnectedWallet } from "../wallet/provider.js";
import { playCtaState } from "./hubCta.js";

/** F-W3 active hero/minicards: everything derives from the item's own
 * fields — no game identity exists on ongoing entries (I7). */
function ActivePane(props: {
  readonly page: GamesPage<OngoingGameItem>;
  readonly meta: Meta;
}) {
  const [hero] = props.page.items;
  if (hero === undefined) {
    return (
      <div className="empty">
        <span className="vt">[ NO SIGNAL ]</span>
        no moves in flight — your next board is one PLAY away.
      </div>
    );
  }
  const uci = parseUci(hero.yourMove.uci);
  return (
    <div data-testid="active-pane">
      <div className="herocard" data-testid="active-hero">
        <BoardLoop
          from={uci.from}
          to={uci.to}
          san={hero.yourMove.san}
          side={hero.yourSide}
          fen={hero.fenBeforeYourMove}
        />
        <dl className="qv-fields">
          <dt>your move</dt>
          <dd className="mv">{hero.yourMove.san}</dd>
          <dt>side</dt>
          <dd>{hero.yourSide}</dd>
          <dt>stake</dt>
          <dd>
            {hero.demo ? (
              <span className="chip">DEMO</span>
            ) : (
              <>
                {formatMicroUsdc(hero.stakeMicroUsdc)}
                {hero.payTxid !== null ? (
                  <>
                    {" "}
                    <a
                      href={explorerTxUrl(
                        props.meta.network.explorerBaseUrl,
                        hero.payTxid,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      tx ↗
                    </a>
                  </>
                ) : null}
              </>
            )}
          </dd>
          <dt>claimed</dt>
          <dd>{formatLocalTime(hero.claimedAt)}</dd>
          <dt>position</dt>
          <dd className="dim">▒▒▒ redacted until the game ends</dd>
          <dt>opponents</dt>
          <dd className="dim">▒▒▒ · pending…</dd>
        </dl>
      </div>
    </div>
  );
}

/** F-W3 latest finished entry: staked games replay lazily; demo games keep
 * their identity and replay hidden. Older entries live only in the archive. */
function FinishedPane(props: {
  readonly client: ApiClient;
  readonly page: GamesPage<FinishedGameItem>;
  readonly meta: Meta;
  readonly refCode: string | null;
}) {
  const items = props.page.items;
  const [sharing, setSharing] = useState(false);
  const [hero] = items;
  if (hero === undefined) {
    return (
      <div className="empty">
        <span className="vt">[ NO SIGNAL ]</span>
        your first board is one <span className="win">PLAY</span> away.
      </div>
    );
  }

  const heroOutcome = outcomeFor(hero.result, hero.yourSide);
  if (!isFinishedStakedItem(hero)) {
    const repetitionNotice = repetitionAdjudicationNotice(
      hero.result,
      hero.repetitionAdjudication,
    );
    return (
      <div data-testid="finished-pane">
        <div
          className="herocard demo-finished-hero"
          data-testid="finished-demo-hero"
        >
          <dl className="qv-fields">
            <dt>game</dt>
            <dd className="vt">— demo —</dd>
            <dt>result</dt>
            <dd>{outcomeGlyph(heroOutcome)}</dd>
            {repetitionNotice === null ? null : (
              <>
                <dt>decision</dt>
                <dd>{repetitionNotice}</dd>
              </>
            )}
            <dt>you played</dt>
            <dd>{hero.yourSide}</dd>
            <dt>your {hero.yourMoves.length === 1 ? "move" : "moves"}</dt>
            <dd className="mv">{finishedMovesLabel(hero)}</dd>
            <dt>stake</dt>
            <dd>
              <span className="chip">DEMO</span>
            </dd>
            <dt>replay</dt>
            <dd className="dim">locked for demo moves</dd>
            <dt>thinking time</dt>
            <dd>{formatElapsedTime(hero.thinkingTimeMs)}</dd>
            <dt>duration</dt>
            <dd>{formatGameDuration(hero.startedAt, hero.finishedAt)}</dd>
          </dl>
        </div>
      </div>
    );
  }

  const heroPayoutChip = payoutChip(hero.payoutStatus);
  const plies = ownedPlies(hero);
  const fullReplayPath = replayPath(hero.gameId, plies);
  return (
    <div data-testid="finished-pane">
      <div className="herocard" data-testid="finished-hero">
        <CachedDigest
          client={props.client}
          gameId={hero.gameId}
          highlightPlies={plies}
        />
        <dl className="qv-fields">
          <dt>game</dt>
          <dd className="vt">{formatGameLabel(hero.gameId)}</dd>
          <dt>result</dt>
          <dd>
            {outcomeGlyph(heroOutcome)}
            {heroOutcome === "won" ? (
              <>
                {" "}
                <button
                  type="button"
                  className="btn pri mini"
                  onClick={() => setSharing(true)}
                >
                  share ▸
                </button>
              </>
            ) : null}
          </dd>
          <dt>you played</dt>
          <dd>{hero.yourSide}</dd>
          <dt>your {hero.yourMoves.length === 1 ? "move" : "moves"}</dt>
          <dd>{finishedMovesLabel(hero)}</dd>
          <dt>stake</dt>
          <dd>
            {formatMicroUsdc(hero.stakeMicroUsdc)}
            {hero.payTxid !== null ? (
              <>
                {" "}
                <a
                  href={explorerTxUrl(
                    props.meta.network.explorerBaseUrl,
                    hero.payTxid,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  tx ↗
                </a>
              </>
            ) : null}
          </dd>
          <dt>payout</dt>
          <dd>
            {formatMicroUsdc(hero.payoutMicroUsdc)}
            {heroPayoutChip !== null ? (
              <span className="chip"> {heroPayoutChip}</span>
            ) : null}
            {hero.payoutTxid !== null ? (
              <>
                {" "}
                <a
                  href={explorerTxUrl(
                    props.meta.network.explorerBaseUrl,
                    hero.payoutTxid,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  tx ↗
                </a>
              </>
            ) : null}
          </dd>
          <dt>thinking time</dt>
          <dd>{formatElapsedTime(hero.thinkingTimeMs)}</dd>
          <dt>duration</dt>
          <dd>{formatGameDuration(hero.startedAt, hero.finishedAt)}</dd>
        </dl>
        <p>
          <Link to={fullReplayPath}>full replay ▸</Link>
        </p>
        {sharing ? (
          <ShareSheet
            gameId={hero.gameId}
            yourPlies={plies}
            refCode={props.refCode}
            onClose={() => setSharing(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

export function Hub(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly player: PlayerView;
}) {
  const live = useLive();
  const { profile, ongoing, finished } = live;
  const [pane, setPane] = useState<"active" | "finished">("active");
  const [gamePaneDismissed, setGamePaneDismissed] = useState(false);
  const [walletSheetOpen, setWalletSheetOpen] = useState(false);
  const [checkingStakeBalance, setCheckingStakeBalance] = useState(false);
  const [stakeBalanceError, setStakeBalanceError] = useState<string | null>(
    null,
  );
  const stakeBalanceCheckInFlight = useRef(false);
  const walletRequest = useRef<{
    readonly promise: Promise<ConnectedWallet>;
    readonly resolve: (wallet: ConnectedWallet) => void;
    readonly reject: (reason: Error) => void;
  } | null>(null);
  const handledLiveSeq = useRef(0);

  const getWallet = useCallback(async (): Promise<ConnectedWallet> => {
    const module = await loadWalletModule(props.meta.network.caip2);
    const connected = module.current();
    if (connected?.address === props.player.address) return connected;
    if (connected !== null) await module.disconnect().catch(() => undefined);
    const pending = walletRequest.current;
    if (pending !== null) return pending.promise;
    let resolvePromise: (wallet: ConnectedWallet) => void = () => undefined;
    let rejectPromise: (reason: Error) => void = () => undefined;
    const promise = new Promise<ConnectedWallet>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    walletRequest.current = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    setWalletSheetOpen(true);
    return promise;
  }, [props.player.address, props.meta.network.caip2]);

  const cancelWallet = useCallback(() => {
    const error = new Error("wallet connection cancelled");
    error.name = "AbortError";
    walletRequest.current?.reject(error);
    walletRequest.current = null;
    setWalletSheetOpen(false);
  }, []);

  useEffect(
    () => () => {
      const error = new Error("wallet request closed");
      error.name = "AbortError";
      walletRequest.current?.reject(error);
      walletRequest.current = null;
    },
    [],
  );

  const flow = usePlayFlow({
    client: props.client,
    meta: props.meta,
    address: props.player.address,
    enabled: true,
    getPaymentSigner: getWallet,
  });
  const { state, send, refreshClaim, refreshStatus } = flow;
  const { client } = props;

  // A committed move lands in the active pane — refetch when the surface
  // closes (SSE-driven invalidation arrives with #51).
  const [wasOpen, setWasOpen] = useState(false);
  useEffect(() => {
    if (state.phase !== "IDLE") setWasOpen(true);
    else if (wasOpen) {
      setWasOpen(false);
      live.refreshAll();
    }
  }, [state.phase, wasOpen, live.refreshAll]);

  const claimOpen =
    state.phase === "FOCUS" ||
    state.phase === "CONFIRM" ||
    state.phase === "SIGNING" ||
    state.phase === "SETTLING";

  useEffect(() => {
    live.setPlaySurfaceVisible(state.phase !== "IDLE");
    return () => live.setPlaySurfaceVisible(false);
  }, [state.phase, live.setPlaySurfaceVisible]);

  useEffect(() => {
    if (claimOpen && state.claim !== undefined) live.trackClaim(state.claim);
    if (state.phase === "RECEIPT" || state.phase === "EXPIRED") {
      live.trackClaim(null);
    }
  }, [claimOpen, state.claim, state.phase, live.trackClaim]);

  useEffect(() => {
    const event = live.lastEvent;
    if (event === null || event.seq <= handledLiveSeq.current) return;
    handledLiveSeq.current = event.seq;
    if (
      event.type === "claim_expiring" &&
      event.payload.claimId === state.claim?.claimId &&
      state.claim !== undefined
    ) {
      send({
        type: "CLAIM_REFRESHED",
        claim: { ...state.claim, deadline: event.payload.deadline },
      });
    } else if (
      event.type === "claim_expired" &&
      event.payload.claimId === state.claim?.claimId
    ) {
      send({ type: "CLAIM_EXPIRED" });
    } else if (
      event.type === "move_accepted" &&
      event.payload.claimId === state.claim?.claimId
    ) {
      refreshStatus();
    } else if (event.type === "stream_reset") {
      refreshClaim();
    }
  }, [live.lastEvent, state.claim, send, refreshClaim, refreshStatus]);

  const newestFinishedAt = finished?.items[0]?.finishedAt ?? null;
  const [unseenFinished, setUnseenFinished] = useState(false);
  useEffect(() => {
    if (newestFinishedAt === null) return;
    const seen = readLastSeenFinishedAt();
    setUnseenFinished(seen === null || newestFinishedAt > seen);
  }, [newestFinishedAt]);

  const showFinished = useCallback(() => {
    setPane("finished");
    if (newestFinishedAt !== null) writeLastSeenFinishedAt(newestFinishedAt);
    setUnseenFinished(false);
  }, [newestFinishedAt]);
  const paused = props.meta.status.mode === "paused";
  const cta = playCtaState({
    phase: state.phase,
    paused,
    ...(state.retryAfterSeconds === undefined
      ? {}
      : { quotaRetryAfterSeconds: state.retryAfterSeconds }),
  });

  // Disabled-CTA reasons follow the quota fields from `/my/profile` (F-W3).
  const stakedQuotaOut =
    profile !== null && profile.quotas.staked.remaining === 0;
  const demoQuotaOut = profile !== null && profile.quotas.demo.remaining === 0;
  const quotaReason =
    stakedQuotaOut && profile?.quotas.staked.resetsAt != null
      ? `out of boards this hour — next at ${formatLocalTime(profile.quotas.staked.resetsAt)}`
      : null;

  const stake = props.meta.economics.humanStakeMicroUsdc;

  const start = useCallback(
    async (demo: boolean) => {
      setGamePaneDismissed(false);
      if (claimOpen) return;
      if (demo) {
        setStakeBalanceError(null);
        live.consumePlayNudge();
        send({ type: "PLAY", demo: true });
        return;
      }
      if (stakeBalanceCheckInFlight.current) return;
      stakeBalanceCheckInFlight.current = true;
      setCheckingStakeBalance(true);
      setStakeBalanceError(null);
      let checked: Awaited<ReturnType<ApiClient["getProfile"]>>;
      try {
        checked = await client.getProfile({ balances: true });
      } catch {
        setStakeBalanceError(
          "could not check your USDC balance — try again before reserving a board",
        );
        stakeBalanceCheckInFlight.current = false;
        setCheckingStakeBalance(false);
        return;
      }
      stakeBalanceCheckInFlight.current = false;
      setCheckingStakeBalance(false);
      const usdc = checked.balances?.usdcMicroUsdc;
      if (usdc === undefined) {
        setStakeBalanceError(
          "could not check your USDC balance — try again before reserving a board",
        );
        return;
      }
      if (usdc < stake) {
        setStakeBalanceError(
          `not enough USDC to play — this board needs ${formatMicroUsdc(stake)}`,
        );
        return;
      }
      live.consumePlayNudge();
      send({ type: "PLAY", demo: false });
    },
    [claimOpen, client, live.consumePlayNudge, send, stake],
  );

  const surfaceVisible = state.phase !== "IDLE";
  const gamePanePhase = state.phase === "CLAIMING" || state.phase === "FOCUS";
  const acceptedMove =
    live.lastEvent?.type === "move_accepted" ? live.lastEvent.payload : null;
  const playView = (
    <PlayView flow={flow} meta={props.meta} acceptedMove={acceptedMove} />
  );
  return (
    <AppShell
      belowBar={<PromoStrip />}
      topRight={<PlayerStatus client={client} player={props.player} />}
    >
      <div className="hubplay">
        <div className="hub-actions">
          <button
            type="button"
            className={`bigplay primary${live.playPulse > 0 ? " live-pulse" : ""}`}
            disabled={
              checkingStakeBalance ||
              (claimOpen ? state.demo : cta.disabled || stakedQuotaOut)
            }
            onClick={() => void start(false)}
          >
            <span className="bp-title">▸ PLAY · {formatCents(stake)}</span>
          </button>
          <button
            type="button"
            className="bigplay demo"
            disabled={
              checkingStakeBalance ||
              (claimOpen ? !state.demo : cta.disabled || demoQuotaOut)
            }
            onClick={() => void start(true)}
          >
            <span className="bp-title">▸ DEMO PLAY · {formatCents(0)}</span>
          </button>
        </div>
        {stakeBalanceError !== null ? (
          <p className="ctareason" role="alert">
            {stakeBalanceError}
          </p>
        ) : cta.reason !== null ? (
          <p className="ctareason">{cta.reason}</p>
        ) : quotaReason !== null ? (
          <p className="ctareason">
            {quotaReason}
            {!demoQuotaOut ? " · demo boards remain" : ""}
          </p>
        ) : null}

        {profile === null ? null : (
          <StarterStakeBanner
            client={client}
            meta={props.meta}
            profile={profile}
            getWallet={getWallet}
            onRefresh={live.refreshAll}
          />
        )}

        <div className="panes" data-testid="hub-panes">
          <div className="tabrow" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={pane === "active"}
              className={pane === "active" ? "tab active" : "tab"}
              onClick={() => setPane("active")}
            >
              LAST ACTIVE
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pane === "finished"}
              className={pane === "finished" ? "tab active" : "tab"}
              onClick={showFinished}
            >
              LAST FINISHED
              {unseenFinished ? <span aria-hidden="true"> · NEW</span> : null}
            </button>
          </div>
          {pane === "active" ? (
            ongoing === null ? (
              <p className="console">&gt; loading…</p>
            ) : (
              <ActivePane page={ongoing} meta={props.meta} />
            )
          ) : finished === null ? (
            <p className="console">&gt; loading…</p>
          ) : (
            <FinishedPane
              client={client}
              page={finished}
              meta={props.meta}
              refCode={profile?.refCode ?? null}
            />
          )}
        </div>
        <p className="archivelink">
          <Link to="/archive">full archive ▸</Link>
        </p>
      </div>
      {surfaceVisible ? (
        gamePanePhase ? (
          gamePaneDismissed ? null : (
            <GamePane
              label="game"
              testId="hub-game-popover"
              onClose={() => setGamePaneDismissed(true)}
            >
              {playView}
            </GamePane>
          )
        ) : (
          playView
        )
      ) : null}
      {walletSheetOpen ? (
        <PaymentWalletSheet
          address={props.player.address}
          caip2={props.meta.network.caip2}
          onConnected={(wallet) => {
            walletRequest.current?.resolve(wallet);
            walletRequest.current = null;
            setWalletSheetOpen(false);
          }}
          onCancel={cancelWallet}
        />
      ) : null}
    </AppShell>
  );
}
