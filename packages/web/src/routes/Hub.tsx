import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { ApiClient } from "../api/client.js";
import { fetchReplayCached } from "../api/replayCache.js";
import type {
  FinishedGameItem,
  FinishedStakedItem,
  GamesPage,
  Meta,
  OngoingGameItem,
  PlayerView,
  ProfileView,
  ReplayView,
} from "../api/schemas.js";
import { useSession } from "../auth/SessionContext.jsx";
import { BoardLoop } from "../board/BoardLoop.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { PromoStrip } from "../components/PromoStrip.jsx";
import { WalletPopover } from "../components/WalletPopover.jsx";
import { outcomeFor, outcomeGlyph } from "../games/outcome.js";
import { payoutChip } from "../games/QuickView.jsx";
import { shortenAddress } from "../lib/address.js";
import { explorerTxUrl } from "../lib/explorer.js";
import { parseUci } from "../lib/fen.js";
import { formatLocalTime, formatMicroUsdc } from "../lib/format.js";
import { PlayView } from "../play/PlayView.jsx";
import { usePlayFlow } from "../play/usePlayFlow.js";
import { DigestLoop } from "../replay/DigestLoop.jsx";
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
              className="minicard"
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
}) {
  const items = props.page.items;
  // `demo` is the discriminator — never field presence (I7 defense in depth).
  const hero = items.find(
    (item): item is FinishedStakedItem => !item.demo && "gameId" in item,
  );
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const { client } = props;

  useEffect(() => {
    if (hero === undefined) return;
    let cancelled = false;
    fetchReplayCached(client, hero.gameId)
      .then((fetched) => {
        if (!cancelled) setReplay(fetched);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, hero]);

  if (items.length === 0) {
    return (
      <div className="empty">
        <span className="vt">[ NO SIGNAL ]</span>
        your first board is one <span className="win">PLAY</span> away.
      </div>
    );
  }

  const rest = items.filter((item) => item !== hero);
  return (
    <div data-testid="finished-pane">
      {hero !== undefined ? (
        <div className="herocard" data-testid="finished-hero">
          {replay !== null ? (
            <DigestLoop
              plies={replay.plies.map((item) => ({
                fenAfter: item.fenAfter,
                from: parseUci(item.move.uci).from,
                to: parseUci(item.move.uci).to,
              }))}
              highlightPly={hero.yourPly}
            />
          ) : (
            <p className="console">&gt; loading replay…</p>
          )}
          <dl className="qv-fields">
            <dt>game</dt>
            <dd className="vt">{hero.gameName}</dd>
            <dt>result</dt>
            <dd>{outcomeGlyph(outcomeFor(hero.result, hero.yourSide))}</dd>
            <dt>your move</dt>
            <dd>
              {hero.yourMove.san} · ply {hero.yourPly}
            </dd>
            <dt>payout</dt>
            <dd>
              {formatMicroUsdc(hero.payoutMicroUsdc)}
              {payoutChip(hero.payoutStatus) !== null ? (
                <span className="chip"> {payoutChip(hero.payoutStatus)}</span>
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
        </div>
      ) : null}
      {rest.length > 0 ? (
        <div className="minicards">
          {rest.map((item, index) =>
            !item.demo && "gameId" in item ? (
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
  const { logout, signedIn } = useSession();
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [ongoing, setOngoing] = useState<GamesPage<OngoingGameItem> | null>(
    null,
  );
  const [finished, setFinished] = useState<GamesPage<FinishedGameItem> | null>(
    null,
  );
  const [pane, setPane] = useState<"active" | "finished">("active");
  const [popover, setPopover] = useState(false);
  const flow = usePlayFlow({
    client: props.client,
    meta: props.meta,
    address: props.player.address,
    enabled: true,
  });
  const { state } = flow;
  const { client } = props;

  const refresh = useCallback(() => {
    client
      .getProfile()
      .then(setProfile)
      .catch(() => undefined);
    client
      .getOngoingGames(1)
      .then(setOngoing)
      .catch(() => undefined);
    client
      .getFinishedGames(1)
      .then(setFinished)
      .catch(() => undefined);
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A committed move lands in the active pane — refetch when the surface
  // closes (SSE-driven invalidation arrives with #51).
  const [wasOpen, setWasOpen] = useState(false);
  useEffect(() => {
    if (state.phase !== "IDLE") setWasOpen(true);
    else if (wasOpen) {
      setWasOpen(false);
      refresh();
    }
  }, [state.phase, wasOpen, refresh]);

  const claimOpen =
    state.phase === "FOCUS" ||
    state.phase === "CONFIRM" ||
    state.phase === "SIGNING" ||
    state.phase === "SETTLING";
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
      flow.send({ type: "PLAY", demo });
    },
    [flow],
  );

  const surfaceVisible = state.phase !== "IDLE";
  const stats = profile?.stats;

  return (
    <AppShell
      belowBar={<PromoStrip />}
      topRight={
        <>
          <Link className="chip click" to="/archive">
            ARCHIVE
          </Link>
          {stats !== undefined ? (
            <span className="chip" data-testid="stats-chip">
              W {stats.wins} · D {stats.draws} · L {stats.losses}
              {stats.winratePct !== null
                ? ` · ${Math.round(stats.winratePct)}%`
                : ""}
            </span>
          ) : null}
          <button
            type="button"
            className="chip click"
            title={props.player.address}
            onClick={() => setPopover((open) => !open)}
          >
            {props.player.nickname} · {shortenAddress(props.player.address)}
          </button>
          {popover ? (
            <WalletPopover
              client={client}
              player={props.player}
              onRenamed={(player) => signedIn(player)}
              onLogout={() => void logout()}
              onClose={() => setPopover(false)}
            />
          ) : null}
        </>
      }
    >
      <div className={surfaceVisible && claimOpen ? "focus-dim" : ""}>
        {!claimOpen ? (
          <div className="hubplay">
            <div className="hub-actions">
              <button
                type="button"
                className="bigplay primary"
                disabled={cta.disabled || stakedQuotaOut}
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
                disabled={cta.disabled || demoQuotaOut}
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
                  ACTIVE
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={pane === "finished"}
                  className={pane === "finished" ? "tab active" : "tab"}
                  onClick={() => setPane("finished")}
                >
                  FINISHED
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
                />
              )}
            </div>
          </div>
        ) : null}
      </div>
      {surfaceVisible ? <PlayView flow={flow} meta={props.meta} /> : null}
    </AppShell>
  );
}
