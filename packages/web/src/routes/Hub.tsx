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
import { isFinishedStakedItem } from "../games/items.js";
import { outcomeFor, outcomeGlyph } from "../games/outcome.js";
import { payoutChip } from "../games/QuickView.jsx";
import { explorerTxUrl } from "../lib/explorer.js";
import { parseUci } from "../lib/fen.js";
import { formatLocalTime, formatMicroUsdc } from "../lib/format.js";
import {
  readLastSeenFinishedAt,
  writeLastSeenFinishedAt,
} from "../lib/storage.js";
import { useLive } from "../live/LiveContext.jsx";
import { PlayView } from "../play/PlayView.jsx";
import { usePlayFlow } from "../play/usePlayFlow.js";
import { CachedDigest } from "../replay/CachedDigest.jsx";
import { playCtaState } from "./hubCta.js";

/** F-W3 active hero/minicards: everything derives from the item's own
 * fields — no game identity exists on ongoing entries (I7). */
function ActivePane(props: {
  readonly page: GamesPage<OngoingGameItem>;
  readonly meta: Meta;
}) {
  const [hero, ...rest] = props.page.items;
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
      {rest.length > 0 ? (
        <div className="minicards">
          {rest.map((item, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: ongoing entries carry no id on purpose (I7)
              key={index}
              className="minicard active-minicard"
              data-testid="active-minicard"
            >
              <span className="mv">{item.yourMove.san}</span> · {item.yourSide}{" "}
              ·{" "}
              {item.demo ? (
                <span className="chip">DEMO</span>
              ) : (
                formatMicroUsdc(item.stakeMicroUsdc)
              )}{" "}
              · pending…
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** F-W3 finished hero: replays the full game lazily (cached) with the own
 * ply accented; demo minicards carry no identity and no replay. */
function FinishedPane(props: {
  readonly client: ApiClient;
  readonly page: GamesPage<FinishedGameItem>;
  readonly meta: Meta;
  readonly refCode: string | null;
}) {
  const items = props.page.items;
  const [sharing, setSharing] = useState(false);
  const hero = items.find(isFinishedStakedItem);
  if (items.length === 0) {
    return (
      <div className="empty">
        <span className="vt">[ NO SIGNAL ]</span>
        your first board is one <span className="win">PLAY</span> away.
      </div>
    );
  }

  const rest = items.filter((item) => item !== hero);
  const heroOutcome =
    hero === undefined ? null : outcomeFor(hero.result, hero.yourSide);
  const heroPayoutChip =
    hero === undefined ? null : payoutChip(hero.payoutStatus);
  return (
    <div data-testid="finished-pane">
      {hero !== undefined ? (
        <div className="herocard" data-testid="finished-hero">
          <CachedDigest
            client={props.client}
            gameId={hero.gameId}
            highlightPly={hero.yourPly}
          />
          <dl className="qv-fields">
            <dt>game</dt>
            <dd className="vt">{hero.gameName}</dd>
            <dt>result</dt>
            <dd>
              {heroOutcome === null ? null : outcomeGlyph(heroOutcome)}
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
            <dt>your move</dt>
            <dd>
              {hero.yourMove.san} · ply {hero.yourPly}
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
          </dl>
          <p>
            <Link to={`/replay/${hero.gameId}?ply=${hero.yourPly}`}>
              full replay ▸
            </Link>
          </p>
          {sharing ? (
            <ShareSheet
              gameId={hero.gameId}
              yourPly={hero.yourPly}
              refCode={props.refCode}
              onClose={() => setSharing(false)}
            />
          ) : null}
        </div>
      ) : null}
      {rest.length > 0 ? (
        <div className="minicards">
          {rest.map((item, index) =>
            isFinishedStakedItem(item) ? (
              <Link
                key={item.gameId}
                className="minicard"
                to={`/replay/${item.gameId}?ply=${item.yourPly}`}
              >
                <span className="vt">{item.gameName}</span> ·{" "}
                {outcomeGlyph(outcomeFor(item.result, item.yourSide))} ·{" "}
                {formatMicroUsdc(item.payoutMicroUsdc)}
              </Link>
            ) : (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: demo entries carry no id on purpose (I7)
                key={`demo-${index}`}
                className="minicard demo"
                data-testid="finished-demo-minicard"
              >
                {outcomeGlyph(outcomeFor(item.result, item.yourSide))} ·{" "}
                <span className="mv">{item.yourMove.san}</span> ·{" "}
                <span className="chip">DEMO</span> · replay locked for demo
                moves
              </span>
            ),
          )}
        </div>
      ) : null}
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
  const handledLiveSeq = useRef(0);
  const flow = usePlayFlow({
    client: props.client,
    meta: props.meta,
    address: props.player.address,
    enabled: true,
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
  const payout = stake * props.meta.economics.humanTargetMult;

  const start = useCallback(
    (demo: boolean) => {
      setGamePaneDismissed(false);
      if (!claimOpen) {
        live.consumePlayNudge();
        send({ type: "PLAY", demo });
      }
    },
    [claimOpen, send, live.consumePlayNudge],
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
            disabled={!claimOpen && (cta.disabled || stakedQuotaOut)}
            onClick={() => start(false)}
          >
            <span className="bp-title">▸ PLAY</span>
            <span className="bp-sub">
              {formatMicroUsdc(stake)} on one move in a live game — win pays{" "}
              {formatMicroUsdc(payout)}
            </span>
          </button>
          <button
            type="button"
            className="bigplay demo"
            disabled={!claimOpen && (cta.disabled || demoQuotaOut)}
            onClick={() => start(true)}
          >
            <span className="bp-title">▸ DEMO PLAY</span>
            <span className="bp-sub">
              $0 — same live games · no stats · no replay
            </span>
          </button>
        </div>
        {cta.reason !== null ? (
          <p className="ctareason">{cta.reason}</p>
        ) : quotaReason !== null ? (
          <p className="ctareason">
            {quotaReason}
            {!demoQuotaOut ? " · demo boards remain" : ""}
          </p>
        ) : null}

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
    </AppShell>
  );
}
