import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ApiError } from "../api/client.js";
import type {
  AdminActivity,
  AdminActivityWindow,
  AdminBonuses,
  AdminConfig,
  AdminConfigItem,
  AdminError,
  AdminGameDossier,
  AdminGameSummary,
  AdminOverview,
  AdminPlayer,
  AdminPlayerSummary,
  AdminPlayers,
  GamesPage,
  Meta,
} from "../api/schemas.js";
import { Board } from "../board/Board.jsx";
import { explorerTxUrl } from "../lib/explorer.js";
import {
  formatGameLabel,
  formatLocalTime,
  formatMicroAlgo,
  formatMicroUsdc,
  formatThinkingTime,
} from "../lib/format.js";
import type { AdminClient } from "./client.js";

function errorHint(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.envelope.hint : fallback;
}

function Metric(props: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="admin-metric">
      <span>{props.label}</span>
      <strong>{props.children}</strong>
    </div>
  );
}

function PageControls(props: {
  readonly page: number;
  readonly pageCount: number;
  readonly onPage: (page: number) => void;
}) {
  if (props.pageCount <= 1) return null;
  return (
    <nav className="admin-page-controls" aria-label="pagination">
      <button
        type="button"
        className="btn mini"
        disabled={props.page <= 1}
        onClick={() => props.onPage(props.page - 1)}
      >
        ◂ previous
      </button>
      <span>
        page {props.page} / {props.pageCount}
      </span>
      <button
        type="button"
        className="btn mini"
        disabled={props.page >= props.pageCount}
        onClick={() => props.onPage(props.page + 1)}
      >
        next ▸
      </button>
    </nav>
  );
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function playerStatus(player: AdminPlayerSummary): string {
  if (player.banned) return "banned";
  if (
    player.deprioritizedUntil !== null &&
    Date.parse(player.deprioritizedUntil) > Date.now()
  ) {
    return "deprioritized";
  }
  return "active";
}

const WINDOWS: readonly AdminActivityWindow[] = ["24h", "7d", "30d", "all"];

export function ActivityPanel(props: {
  readonly client: AdminClient;
  readonly onPlayer: (address: string) => void;
  readonly reloadToken: number;
}) {
  const { reloadToken } = props;
  const [window, setWindow] = useState<AdminActivityWindow>("24h");
  const [data, setData] = useState<AdminActivity | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadToken): a manual Reload refetches without changing the query inputs
  useEffect(() => {
    let cancelled = false;
    setError(null);
    props.client
      .getAdminActivity(window)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(errorHint(reason, "activity data unavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, reloadToken, window]);

  return (
    <section className="admin-panel" aria-labelledby="admin-activity-title">
      <header>
        <div>
          <h2 id="admin-activity-title">ACTIVITY</h2>
          <p>population, funnel, volume, and incident tripwires</p>
        </div>
        <fieldset className="admin-segmented">
          <legend>activity window</legend>
          {WINDOWS.map((item) => (
            <button
              type="button"
              className={item === window ? "btn mini toggled" : "btn mini"}
              aria-pressed={item === window}
              onClick={() => setWindow(item)}
              key={item}
            >
              {item === "all" ? "all-time" : item}
            </button>
          ))}
        </fieldset>
      </header>
      {error === null ? null : (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {data === null ? (
        <p className="dim">loading activity…</p>
      ) : (
        <>
          <div className="admin-metrics">
            <Metric label="active humans">{data.counts.activeHumans}</Metric>
            <Metric label="active agents">{data.counts.activeAgents}</Metric>
            <Metric label="demo-only">{data.counts.demoOnlyPlayers}</Metric>
            <Metric label="registrations">{data.counts.registrations}</Metric>
            <Metric label="human moves">{data.counts.humanMoves}</Metric>
            <Metric label="agent moves">{data.counts.agentMoves}</Metric>
            <Metric label="demo moves">{data.counts.demoMoves}</Metric>
            <Metric label="games finished">{data.counts.gamesFinished}</Metric>
          </div>
          <div className="admin-columns">
            <div className="admin-subpanel">
              <h3>CLAIMS FUNNEL</h3>
              <dl className="admin-dl">
                <div>
                  <dt>created</dt>
                  <dd>{data.counts.claimsCreated}</dd>
                </div>
                <div>
                  <dt>moved</dt>
                  <dd>{data.counts.claimsMoved}</dd>
                </div>
                <div>
                  <dt>expired</dt>
                  <dd>{data.counts.claimsExpired}</dd>
                </div>
                <div>
                  <dt>human conversion</dt>
                  <dd>{pct(data.tripwires.claimMovePctHuman)}</dd>
                </div>
                <div>
                  <dt>agent conversion</dt>
                  <dd>{pct(data.tripwires.claimMovePctAgent)}</dd>
                </div>
              </dl>
            </div>
            <div className="admin-subpanel">
              <h3>MONEY</h3>
              <dl className="admin-dl">
                <div>
                  <dt>stake volume</dt>
                  <dd>{formatMicroUsdc(data.money.stakeVolumeMicroUsdc)}</dd>
                </div>
                <div>
                  <dt>payout volume</dt>
                  <dd>{formatMicroUsdc(data.money.payoutVolumeMicroUsdc)}</dd>
                </div>
                <div>
                  <dt>protocol take</dt>
                  <dd>{formatMicroUsdc(data.money.protocolTakeMicroUsdc)}</dd>
                </div>
                <div>
                  <dt>treasury net flow</dt>
                  <dd>
                    {formatMicroUsdc(data.money.treasuryNetFlowMicroUsdc)}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="admin-subpanel">
              <h3>TRIPWIRES</h3>
              <dl className="admin-dl">
                <div>
                  <dt>demo share</dt>
                  <dd>{pct(data.tripwires.demoSharePct)}</dd>
                </div>
                <div>
                  <dt>demo → staked</dt>
                  <dd>{pct(data.tripwires.demoToStakedPct)}</dd>
                </div>
                <div>
                  <dt>human latency p50 / p95</dt>
                  <dd>
                    {data.tripwires.humanMoveLatencyP50Seconds ?? "—"}s /{" "}
                    {data.tripwires.humanMoveLatencyP95Seconds ?? "—"}s
                  </dd>
                </div>
                <div>
                  <dt>quota saturation</dt>
                  <dd>{pct(data.tripwires.quotaSaturationPct)}</dd>
                </div>
              </dl>
            </div>
          </div>
          <div className="admin-columns">
            {[
              ["TOP PNL WINNERS", data.tripwires.topWinners],
              ["TOP PNL LOSERS", data.tripwires.topLosers],
            ].map(([title, items]) => (
              <div className="admin-subpanel" key={title as string}>
                <h3>{title as string}</h3>
                {(items as AdminActivity["tripwires"]["topWinners"]).length ===
                0 ? (
                  <p className="dim">no realized PnL in this window</p>
                ) : (
                  <ul className="admin-list">
                    {(items as AdminActivity["tripwires"]["topWinners"]).map(
                      (item) => (
                        <li key={item.address}>
                          <button
                            type="button"
                            className="admin-link"
                            onClick={() => props.onPlayer(item.address)}
                          >
                            {item.nickname || item.address}
                          </button>
                          <span>{formatMicroUsdc(item.pnlMicroUsdc)}</span>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function BonusesPanel(props: {
  readonly client: AdminClient;
  readonly meta: Meta;
  readonly onPlayer: (address: string) => void;
  readonly reloadToken: number;
}) {
  const { reloadToken } = props;
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminBonuses | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryResult, setRetryResult] = useState<Record<string, string>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadToken): a manual Reload refetches without changing the query inputs
  useEffect(() => {
    let cancelled = false;
    props.client
      .getAdminBonuses(page)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorHint(reason, "bonus data unavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [page, props.client, reloadToken]);

  return (
    <section className="admin-panel" aria-labelledby="admin-bonuses-title">
      <header>
        <div>
          <h2 id="admin-bonuses-title">BONUSES</h2>
          <p>manual starter-stake grift review</p>
        </div>
      </header>
      {error === null ? null : (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {data === null ? (
        <p className="dim">loading bonus status…</p>
      ) : (
        <>
          <div className="admin-metrics">
            <Metric label="today / daily cap">
              {data.todayClaimed} / {data.dailyCap}
            </Metric>
            <Metric label="total claimed">{data.totalClaimed}</Metric>
            <Metric label="ALGO sent">
              {formatMicroAlgo(data.totalAlgoMicro)}
            </Metric>
            <Metric label="USDC sent">
              {formatMicroUsdc(data.totalUsdcMicro)}
            </Metric>
          </div>
          {data.items.length === 0 ? (
            <p className="dim">no bonus records</p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>player / IP</th>
                    <th>status</th>
                    <th>funding</th>
                    <th>staked moves / points</th>
                    <th>operations</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.address}>
                      <td>
                        <button
                          type="button"
                          className="admin-link"
                          onClick={() => props.onPlayer(item.address)}
                        >
                          {item.nickname ?? item.address}
                        </button>
                        <small>{item.claimIp}</small>
                      </td>
                      <td>
                        {item.status}
                        <small>claimed {formatLocalTime(item.claimedAt)}</small>
                        {item.fundedAt === null ? null : (
                          <small>funded {formatLocalTime(item.fundedAt)}</small>
                        )}
                      </td>
                      <td>
                        {[item.algoTxid, item.usdcTxid].map((txid) =>
                          txid === null ? null : (
                            <a
                              href={explorerTxUrl(
                                props.meta.network.explorerBaseUrl,
                                txid,
                              )}
                              target="_blank"
                              rel="noreferrer"
                              key={txid}
                            >
                              {txid} ↗
                            </a>
                          ),
                        )}
                      </td>
                      <td>
                        {item.lifetimeStakedMoves} / {item.points}
                        <small>referred by {item.referredBy ?? "nobody"}</small>
                      </td>
                      <td>
                        {item.status === "funded" ? (
                          <span className="dim">complete</span>
                        ) : (
                          <button
                            type="button"
                            className="btn mini"
                            disabled={retrying !== null}
                            onClick={() => {
                              setRetrying(item.address);
                              setError(null);
                              props.client
                                .retryAdminBonus(item.address)
                                .then((result) => {
                                  setRetryResult((current) => ({
                                    ...current,
                                    [item.address]: `${result.jobs} funding leg${result.jobs === 1 ? "" : "s"} re-armed`,
                                  }));
                                  return props.client.getAdminBonuses(page);
                                })
                                .then(setData)
                                .catch((reason) =>
                                  setError(
                                    errorHint(
                                      reason,
                                      "starter-stake retry failed",
                                    ),
                                  ),
                                )
                                .finally(() => setRetrying(null));
                            }}
                          >
                            {retrying === item.address
                              ? "checking…"
                              : "retry funding"}
                          </button>
                        )}
                        {retryResult[item.address] === undefined ? null : (
                          <small role="status">
                            {retryResult[item.address]}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <PageControls
            page={data.page}
            pageCount={data.pageCount}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}

function JobCounts(props: {
  readonly label: string;
  readonly jobs: AdminOverview["payouts"];
}) {
  return (
    <div className="admin-subpanel">
      <h3>{props.label}</h3>
      <p>
        pending {props.jobs.pending} · prepared {props.jobs.prepared} ·
        submitted {props.jobs.submitted} · failed {props.jobs.failed}
      </p>
    </div>
  );
}

export function HealthPanel(props: {
  readonly client: AdminClient;
  readonly overview: AdminOverview;
  readonly reloadToken: number;
}) {
  const { reloadToken } = props;
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<GamesPage<AdminError> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadToken): a manual Reload refetches without changing the query inputs
  useEffect(() => {
    let cancelled = false;
    props.client
      .getAdminErrors({
        page,
        ...(level === "" ? {} : { level }),
        ...(code === "" ? {} : { code }),
      })
      .then((next) => {
        if (!cancelled) setErrors(next);
      })
      .catch((reason) => {
        if (!cancelled) setFailure(errorHint(reason, "error log unavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [code, level, page, props.client, reloadToken]);

  const overview = props.overview;
  // Treasury coverage is part of the health verdict, so the badge label and its
  // colour must derive from the same predicate — otherwise a low-coverage
  // incident renders red styling while still reading "nominal".
  const healthy =
    overview.facilitator.healthy &&
    overview.reconciliation.ok &&
    !overview.treasury.belowRefundCoverage;
  return (
    <section className="admin-panel" aria-labelledby="admin-health-title">
      <header>
        <div>
          <h2 id="admin-health-title">HEALTH</h2>
          <p>process, dependency, settlement, treasury, and alerts</p>
        </div>
        <span className={healthy ? "admin-health-ok" : "admin-health-bad"}>
          {healthy ? "● nominal" : "◆ attention"}
        </span>
      </header>
      <div className="admin-columns">
        <div className="admin-subpanel">
          <h3>PROCESS / LIVE</h3>
          <p>
            uptime {overview.live.uptimeSeconds}s · SSE{" "}
            {overview.live.sseClients}
          </p>
          <p>
            settle p50 {overview.live.settleP50Ms ?? "—"}ms · p95{" "}
            {overview.live.settleP95Ms ?? "—"}ms
          </p>
        </div>
        <div className="admin-subpanel">
          <h3>POOL</h3>
          <p>
            {overview.pool.active} active · {overview.pool.endspiel} endspiel ·{" "}
            {overview.pool.claimsOpen} claims
          </p>
          <p>target {overview.pool.target} non-terminal games</p>
        </div>
        <div className="admin-subpanel">
          <h3>FACILITATOR</h3>
          <p>{overview.facilitator.healthy ? "healthy" : "unhealthy"}</p>
          <p>
            last check{" "}
            {overview.facilitator.lastCheckAt === null
              ? "never"
              : formatLocalTime(overview.facilitator.lastCheckAt)}
          </p>
        </div>
        <JobCounts label="PAYOUTS" jobs={overview.payouts} />
        <JobCounts label="FUNDING" jobs={overview.funding} />
        <div className="admin-subpanel">
          <h3>TREASURY</h3>
          <p>
            {formatMicroUsdc(overview.treasury.usdcMicroUsdc)} ·{" "}
            {formatMicroAlgo(overview.treasury.algoMicroAlgo)}
          </p>
          <p>
            cap {formatMicroUsdc(overview.treasury.capMicroUsdc)} · refund
            coverage {overview.treasury.belowRefundCoverage ? "LOW" : "covered"}
          </p>
        </div>
        <div className="admin-subpanel">
          <h3>BONUS ACCOUNT</h3>
          <p>
            {formatMicroUsdc(overview.bonusAccount.usdcMicroUsdc)} ·{" "}
            {formatMicroAlgo(overview.bonusAccount.algoMicroAlgo)}
          </p>
          <p>gas floor {formatMicroAlgo(overview.bonusAccount.minAlgoMicro)}</p>
        </div>
        <div className="admin-subpanel">
          <h3>RECONCILIATION</h3>
          <p>{overview.reconciliation.ok ? "balanced" : "DRIFT"}</p>
          <p>
            book {formatMicroUsdc(overview.reconciliation.bookMicroUsdc)} ·
            chain {formatMicroUsdc(overview.reconciliation.chainMicroUsdc)}
          </p>
          <p>delta {formatMicroUsdc(overview.reconciliation.driftMicroUsdc)}</p>
        </div>
        <div className="admin-subpanel">
          <h3>ALERT STATE</h3>
          <p>
            mode {overview.mode} · causes{" "}
            {overview.pauseCauses.join(", ") || "none"}
          </p>
          <p>{overview.banner ?? "no system banner"}</p>
        </div>
      </div>
      <div className="admin-error-head">
        <h3>ERROR LOG</h3>
        <label>
          level
          <input
            value={level}
            onChange={(event) => {
              setPage(1);
              setLevel(event.target.value);
            }}
          />
        </label>
        <label>
          code
          <input
            value={code}
            onChange={(event) => {
              setPage(1);
              setCode(event.target.value);
            }}
          />
        </label>
      </div>
      {failure === null ? null : (
        <p className="admin-error" role="alert">
          {failure}
        </p>
      )}
      {errors === null ? (
        <p className="dim">loading error log…</p>
      ) : errors.items.length === 0 ? (
        <p className="dim">no matching errors</p>
      ) : (
        <div className="admin-error-list">
          {errors.items.map((item) => (
            <details key={item.id}>
              <summary>
                <span>{item.level}</span>
                <strong>{item.code}</strong>
                <span>{formatLocalTime(item.at)}</span>
                <span>{item.requestId ?? "no request id"}</span>
              </summary>
              <pre>{JSON.stringify(item.context, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
      {errors === null ? null : (
        <PageControls
          page={errors.page}
          pageCount={errors.pageCount}
          onPage={setPage}
        />
      )}
    </section>
  );
}

function PlayerDossier(props: {
  readonly player: AdminPlayer;
  readonly onClose: () => void;
}) {
  return (
    <section className="admin-dossier" aria-label="player dossier">
      <header>
        <div>
          <h3>{props.player.nickname ?? "unnamed player"}</h3>
          <code>{props.player.address}</code>
        </div>
        <button type="button" className="btn mini" onClick={props.onClose}>
          close
        </button>
      </header>
      <div className="admin-metrics">
        <Metric label="kind">{props.player.kind}</Metric>
        <Metric label="net PnL">
          {formatMicroUsdc(props.player.netPnlMicroUsdc)}
        </Metric>
        <Metric label="W / D / L">
          {props.player.stats.wins} / {props.player.stats.draws} /{" "}
          {props.player.stats.losses}
        </Metric>
        <Metric label="win rate">{pct(props.player.stats.winratePct)}</Metric>
        <Metric label="abandoned">{props.player.abandonCount}</Metric>
        <Metric label="staked quota">
          {props.player.quota.staked.limit === null
            ? "unlimited"
            : `${props.player.quota.staked.remaining} / ${props.player.quota.staked.limit}`}
        </Metric>
        <Metric label="demo quota">
          {props.player.quota.demo.remaining} / {props.player.quota.demo.limit}
        </Metric>
        <Metric label="points">{props.player.points ?? "—"}</Metric>
        <Metric label="banned">{props.player.banned ? "yes" : "no"}</Metric>
      </div>
      <details>
        <summary>recent claims ({props.player.recentClaims.length})</summary>
        <ul className="admin-list">
          {props.player.recentClaims.map((claim) => (
            <li key={claim.id}>
              <span>
                {claim.status} · {claim.move?.san ?? "no move"}
              </span>
              <span>{formatLocalTime(claim.claimedAt)}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export function PlayersPanel(props: {
  readonly client: AdminClient;
  readonly requestedPlayer: string | null;
  readonly onPlayerHandled: () => void;
  readonly reloadToken: number;
}) {
  const { onPlayerHandled, reloadToken, requestedPlayer } = props;
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"" | "human" | "agent">("");
  const [page, setPage] = useState(1);
  const [players, setPlayers] = useState<AdminPlayers | null>(null);
  const [player, setPlayer] = useState<AdminPlayer | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadToken): a manual Reload refetches without changing the query inputs
  useEffect(() => {
    let cancelled = false;
    setError(null);
    props.client
      .getAdminPlayers({
        page,
        ...(query === "" ? {} : { q: query }),
        ...(kind === "" ? {} : { kind }),
      })
      .then((next) => {
        if (!cancelled) setPlayers(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorHint(reason, "player list unavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [kind, page, props.client, reloadToken, query]);

  const openPlayer = useCallback(
    (address: string) => {
      setError(null);
      props.client
        .getAdminPlayer(address)
        .then(setPlayer)
        .catch((reason) =>
          setError(errorHint(reason, "player dossier unavailable")),
        );
    },
    [props.client],
  );

  useEffect(() => {
    if (requestedPlayer === null) return;
    openPlayer(requestedPlayer);
    onPlayerHandled();
  }, [onPlayerHandled, openPlayer, requestedPlayer]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  return (
    <section className="admin-panel" aria-labelledby="admin-players-title">
      <header>
        <div>
          <h2 id="admin-players-title">PLAYERS</h2>
          <p>registered humans and agents, most recently active first</p>
        </div>
        <span className="chip">
          total <b>{players?.total ?? "—"}</b>
        </span>
      </header>
      <form className="admin-search" onSubmit={submit}>
        <label>
          player address or nickname
          <input
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
          />
        </label>
        <label>
          player kind
          <select
            value={kind}
            onChange={(event) => {
              setPage(1);
              setKind(event.target.value as "" | "human" | "agent");
            }}
          >
            <option value="">all</option>
            <option value="human">human</option>
            <option value="agent">agent</option>
          </select>
        </label>
        <button type="submit" className="btn">
          search
        </button>
      </form>
      {error === null ? null : (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {player === null ? null : (
        <PlayerDossier player={player} onClose={() => setPlayer(null)} />
      )}
      {players === null ? (
        <p className="dim">loading players…</p>
      ) : players.items.length === 0 ? (
        <p className="dim">no matching players</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table admin-players-table">
            <thead>
              <tr>
                <th>player</th>
                <th>type</th>
                <th>performance</th>
                <th>engagement</th>
                <th>activity</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {players.items.map((item) => {
                const status = playerStatus(item);
                return (
                  <tr key={item.address}>
                    <td>
                      <button
                        type="button"
                        className="admin-link"
                        onClick={() => openPlayer(item.address)}
                      >
                        {item.nickname ?? "unnamed player"}
                      </button>
                      <code>{item.address}</code>
                    </td>
                    <td>{item.kind}</td>
                    <td>
                      {formatMicroUsdc(item.netPnlMicroUsdc)} net
                      <small>
                        {item.stats.wins} / {item.stats.draws} /{" "}
                        {item.stats.losses} W/D/L · {pct(item.stats.winratePct)}
                      </small>
                    </td>
                    <td>
                      {item.points} points
                      <small>
                        {item.stats.moves} moves · {item.abandonCount} abandons
                      </small>
                    </td>
                    <td>
                      {formatLocalTime(item.lastActiveAt)}
                      <small>joined {formatLocalTime(item.createdAt)}</small>
                    </td>
                    <td>
                      {status}
                      {status !== "deprioritized" ||
                      item.deprioritizedUntil === null ? null : (
                        <small>
                          until {formatLocalTime(item.deprioritizedUntil)}
                        </small>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {players === null ? null : (
        <PageControls
          page={players.page}
          pageCount={players.pageCount}
          onPage={setPage}
        />
      )}
    </section>
  );
}

function GameDossier(props: {
  readonly dossier: AdminGameDossier;
  readonly meta: Meta;
  readonly onPlayer: (address: string) => void;
  readonly onClose: () => void;
}) {
  const participants = useMemo(
    () =>
      [...new Set(props.dossier.claims.map((claim) => claim.player))].map(
        (address) => ({
          address,
          nickname:
            props.dossier.claims.find((claim) => claim.player === address)
              ?.nickname ?? null,
        }),
      ),
    [props.dossier.claims],
  );
  const game = props.dossier.game;
  return (
    <section className="admin-dossier" aria-label="game dossier">
      <header>
        <div>
          <h3>{formatGameLabel(game.id)}</h3>
          <p>
            {game.status} · ply {game.ply} · {game.result ?? "ongoing"} ·{" "}
            {game.termination ?? "no termination"}
          </p>
        </div>
        <button type="button" className="btn mini" onClick={props.onClose}>
          close
        </button>
      </header>
      <div className="admin-game-grid">
        <div className="admin-board">
          <Board fen={game.fen} interactive={false} coords={true} />
        </div>
        <div>
          <h4>PGN</h4>
          <pre>{game.pgn || "PGN unavailable for ongoing game"}</pre>
          <details>
            <summary>rules snapshot</summary>
            <pre>{JSON.stringify(game.rules, null, 2)}</pre>
          </details>
        </div>
      </div>
      <h4>CLAIM TIMELINE</h4>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>player</th>
              <th>claim</th>
              <th>move / thinking</th>
              <th>stake</th>
            </tr>
          </thead>
          <tbody>
            {props.dossier.claims.map((claim) => (
              <tr key={claim.id}>
                <td>
                  <button
                    type="button"
                    className="admin-link"
                    onClick={() => props.onPlayer(claim.player)}
                  >
                    {claim.nickname ?? claim.player}
                  </button>
                  <small>{claim.player}</small>
                </td>
                <td>
                  {claim.status} · {claim.side}
                  <small>
                    {claim.demo ? "demo" : "staked"} ·{" "}
                    {formatLocalTime(claim.claimedAt)}
                  </small>
                </td>
                <td>
                  {claim.move?.san ?? "—"}
                  <small>
                    {claim.movedAt === null
                      ? "not moved"
                      : formatThinkingTime(claim.claimedAt, claim.movedAt)}
                  </small>
                </td>
                <td>{formatMicroUsdc(claim.stakeMicroUsdc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="admin-columns">
        <div className="admin-subpanel">
          <h3>MONEY CONSERVATION</h3>
          {props.dossier.resolution === null ? (
            <p>ongoing — no resolution ledger yet</p>
          ) : (
            <>
              <p>
                payouts{" "}
                {formatMicroUsdc(props.dossier.resolution.payoutsMicroUsdc)} ·
                fee {formatMicroUsdc(props.dossier.resolution.feeMicroUsdc)}
              </p>
              <p>
                dust {formatMicroUsdc(props.dossier.resolution.dustMicroUsdc)} ·
                surplus{" "}
                {formatMicroUsdc(props.dossier.resolution.surplusMicroUsdc)}
              </p>
              <strong>
                {props.dossier.resolution.conserved
                  ? "✓ conserved"
                  : "◆ conservation mismatch"}
              </strong>
            </>
          )}
        </div>
        <div className="admin-subpanel">
          <h3>PAYOUT JOBS</h3>
          {props.dossier.payoutJobs.length === 0 ? (
            <p>none</p>
          ) : (
            <ul className="admin-list">
              {props.dossier.payoutJobs.map((job) => (
                <li key={job.id}>
                  <span>
                    {job.status} · {formatMicroUsdc(job.amountMicroUsdc)} ·{" "}
                    {job.attempts} attempts
                  </span>
                  {job.txid === null ? null : (
                    <a
                      href={explorerTxUrl(
                        props.meta.network.explorerBaseUrl,
                        job.txid,
                      )}
                      target="_blank"
                      rel="noreferrer"
                    >
                      tx ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="admin-subpanel">
          <h3>PARTICIPANTS</h3>
          <ul className="admin-list">
            {participants.map((participant) => (
              <li key={participant.address}>
                <button
                  type="button"
                  className="admin-link"
                  onClick={() => props.onPlayer(participant.address)}
                >
                  {participant.nickname ?? participant.address}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function GamesPanel(props: {
  readonly client: AdminClient;
  readonly meta: Meta;
  readonly reloadToken: number;
}) {
  const { reloadToken } = props;
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [games, setGames] = useState<GamesPage<AdminGameSummary> | null>(null);
  const [dossier, setDossier] = useState<AdminGameDossier | null>(null);
  const [player, setPlayer] = useState<AdminPlayer | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadToken): a manual Reload refetches without changing the query inputs
  useEffect(() => {
    let cancelled = false;
    props.client
      .getAdminGames({
        page,
        ...(query === "" ? {} : { q: query }),
        ...(status === "" ? {} : { status }),
      })
      .then((next) => {
        if (!cancelled) setGames(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorHint(reason, "game list unavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [page, props.client, reloadToken, query, status]);

  const openPlayer = useCallback(
    (address: string) => {
      setError(null);
      props.client
        .getAdminPlayer(address)
        .then(setPlayer)
        .catch((reason) =>
          setError(errorHint(reason, "player dossier unavailable")),
        );
    },
    [props.client],
  );

  const openGame = (gameId: string) => {
    setError(null);
    props.client
      .getAdminGame(gameId)
      .then(setDossier)
      .catch((reason) =>
        setError(errorHint(reason, "game dossier unavailable")),
      );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  return (
    <section className="admin-panel" aria-labelledby="admin-games-title">
      <header>
        <div>
          <h2 id="admin-games-title">GAMES</h2>
          <p>searchable games and player dossiers</p>
        </div>
      </header>
      <form className="admin-search" onSubmit={submit}>
        <label>
          game id or name
          <input
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
          />
        </label>
        <label>
          status
          <select
            value={status}
            onChange={(event) => {
              setPage(1);
              setStatus(event.target.value);
            }}
          >
            <option value="">all</option>
            <option value="active">active</option>
            <option value="endspiel">endspiel</option>
            <option value="finished">finished</option>
            <option value="aborted">aborted</option>
          </select>
        </label>
        <button type="submit" className="btn">
          search
        </button>
      </form>
      {error === null ? null : (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {player === null ? null : (
        <PlayerDossier player={player} onClose={() => setPlayer(null)} />
      )}
      {dossier === null ? null : (
        <GameDossier
          dossier={dossier}
          meta={props.meta}
          onPlayer={openPlayer}
          onClose={() => setDossier(null)}
        />
      )}
      {games === null ? (
        <p className="dim">loading games…</p>
      ) : games.items.length === 0 ? (
        <p className="dim">no matching games</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>game</th>
                <th>state</th>
                <th>pot</th>
                <th>created</th>
              </tr>
            </thead>
            <tbody>
              {games.items.map((game) => (
                <tr key={game.id}>
                  <td>
                    <button
                      type="button"
                      className="admin-link"
                      onClick={() => openGame(game.id)}
                    >
                      {formatGameLabel(game.id)}
                    </button>
                  </td>
                  <td>
                    {game.status} · ply {game.ply}
                    <small>
                      {game.result ?? "ongoing"} · {game.claimsOpen} open claims
                    </small>
                  </td>
                  <td>{formatMicroUsdc(game.stakePotMicroUsdc)}</td>
                  <td>{formatLocalTime(game.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {games === null ? null : (
        <PageControls
          page={games.page}
          pageCount={games.pageCount}
          onPage={setPage}
        />
      )}
    </section>
  );
}

function effectLabel(item: AdminConfigItem): string {
  if (item.effect === "new_claims") {
    return item.key.includes("QUOTA")
      ? "next quota window / new claims"
      : "new claims";
  }
  if (item.effect === "new_games") return "new games";
  if (item.effect === "restart") return "restart";
  return "immediate";
}

function displayValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ConfigRow(props: {
  readonly item: AdminConfigItem;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSet: (value: unknown) => void;
  readonly onRevert: () => void;
}) {
  const [draft, setDraft] = useState(displayValue(props.item.effectiveValue));
  useEffect(() => {
    setDraft(displayValue(props.item.effectiveValue));
  }, [props.item.effectiveValue]);
  return (
    <tr>
      <td>
        <strong>{props.item.key}</strong>
        <span className="admin-config-description">
          {props.item.description}
        </span>
        <small>{effectLabel(props.item)}</small>
      </td>
      <td>
        <code>{displayValue(props.item.defaultValue)}</code>
      </td>
      <td>
        {props.item.overrideValue === null ? (
          <span className="dim">default</span>
        ) : (
          <>
            <span className="badge">OVERRIDDEN</span>
            <code>{displayValue(props.item.overrideValue)}</code>
          </>
        )}
      </td>
      <td>
        <div className="admin-config-edit">
          <input
            aria-label={`${props.item.key} value`}
            value={draft}
            disabled={!props.item.editable || props.busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            className="btn mini"
            disabled={!props.item.editable || props.busy}
            onClick={() => props.onSet(parseValue(draft))}
          >
            save
          </button>
          <button
            type="button"
            className="btn mini"
            disabled={
              !props.item.editable ||
              props.item.overrideValue === null ||
              props.busy
            }
            onClick={props.onRevert}
          >
            revert
          </button>
        </div>
        {props.error === null ? null : (
          <p className="admin-inline-error" role="alert">
            {props.error}
          </p>
        )}
      </td>
    </tr>
  );
}

export function ConfigPanel(props: {
  readonly client: AdminClient;
  readonly onChanged: () => void;
  readonly reloadToken: number;
}) {
  const { reloadToken } = props;
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailure(null);
    props.client
      .getAdminConfig()
      .then(setConfig)
      .catch((reason) =>
        setFailure(errorHint(reason, "configuration unavailable")),
      );
  }, [props.client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadToken): a manual Reload refetches without changing the query inputs
  useEffect(load, [load, reloadToken]);

  const mutate = async (item: AdminConfigItem, action: () => Promise<void>) => {
    setBusyKey(item.key);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[item.key];
      return next;
    });
    try {
      await action();
      load();
      props.onChanged();
    } catch (error) {
      setRowErrors((current) => ({
        ...current,
        [item.key]: errorHint(error, "configuration change failed"),
      }));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="admin-panel" aria-labelledby="admin-config-title">
      <header>
        <div>
          <h2 id="admin-config-title">CONFIG</h2>
          <p>effective values, overrides, and audited history</p>
        </div>
        <span className="chip">
          revision <b>{config?.revision ?? "—"}</b>
        </span>
      </header>
      {failure === null ? null : (
        <p className="admin-error" role="alert">
          {failure}
        </p>
      )}
      {config === null ? (
        <p className="dim">loading configuration…</p>
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table admin-config-table">
              <thead>
                <tr>
                  <th>key / effect</th>
                  <th>default</th>
                  <th>override</th>
                  <th>effective / action</th>
                </tr>
              </thead>
              <tbody>
                {config.items.map((item) => (
                  <ConfigRow
                    item={item}
                    busy={busyKey === item.key}
                    error={rowErrors[item.key] ?? null}
                    onSet={(value) =>
                      void mutate(item, () =>
                        props.client.setAdminConfig(item.key, value),
                      )
                    }
                    onRevert={() =>
                      void mutate(item, () =>
                        props.client.revertAdminConfig(item.key),
                      )
                    }
                    key={item.key}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <details className="admin-history">
            <summary>change history ({config.history.length})</summary>
            <ol>
              {config.history.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.action}</strong> by {entry.actor} ·{" "}
                  {formatLocalTime(entry.at)}
                  <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
