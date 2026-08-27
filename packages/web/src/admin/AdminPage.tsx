import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AdminOverview } from "../api/schemas.js";
import { useSession } from "../auth/SessionContext.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { BootSkeleton } from "../components/BootSkeleton.jsx";
import { useMeta } from "../meta/MetaContext.jsx";
import { NotFound } from "../routes/NotFound.jsx";
import { type AdminClient, createAdminClient } from "./client.js";
import {
  ActivityPanel,
  BonusesPanel,
  ConfigPanel,
  GamesPanel,
  HealthPanel,
  PlayersPanel,
} from "./panels.jsx";
import { useAdminOverview } from "./useAdminOverview.js";

const PANELS = [
  "activity",
  "bonuses",
  "health",
  "games",
  "players",
  "config",
] as const;
type Panel = (typeof PANELS)[number];

function PauseControl(props: {
  readonly client: AdminClient;
  readonly overview: AdminOverview;
  readonly onChanged: () => void;
}) {
  const action = props.overview.mode === "running" ? "pause" : "resume";
  const [confirming, setConfirming] = useState(false);
  const [banner, setBanner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refetch } = useMeta();
  const previousAction = useRef(action);

  useEffect(() => {
    if (previousAction.current === action) return;
    previousAction.current = action;
    setConfirming(false);
    setError(null);
  }, [action]);

  const execute = async () => {
    setBusy(true);
    setError(null);
    try {
      if (action === "pause") await props.client.pauseAdmin(banner);
      else await props.client.resumeAdmin();
      setConfirming(false);
      props.onChanged();
      refetch();
    } catch (reason) {
      const hint =
        reason !== null &&
        typeof reason === "object" &&
        "envelope" in reason &&
        typeof reason.envelope === "object" &&
        reason.envelope !== null &&
        "hint" in reason.envelope &&
        typeof reason.envelope.hint === "string"
          ? reason.envelope.hint
          : `${action} failed`;
      setError(hint);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-pause">
      <div>
        <span className="dim">GLOBAL MODE</span>
        <strong>{props.overview.mode.toUpperCase()}</strong>
        <small>{props.overview.banner ?? "no system banner"}</small>
      </div>
      {confirming ? (
        <fieldset className="admin-confirm">
          <legend>{action} confirmation</legend>
          {action === "pause" ? (
            <label>
              optional system banner
              <input
                value={banner}
                onChange={(event) => setBanner(event.target.value)}
                maxLength={240}
              />
            </label>
          ) : null}
          <span>
            {action === "pause"
              ? "suspend new boards and settlement?"
              : "resume only the manual pause cause?"}
          </span>
          <button
            type="button"
            className="btn pri"
            disabled={busy}
            onClick={() => void execute()}
          >
            confirm {action}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
          >
            cancel
          </button>
        </fieldset>
      ) : (
        <button
          type="button"
          className="btn pri admin-pause-trigger"
          onClick={() => setConfirming(true)}
        >
          {action.toUpperCase()}
        </button>
      )}
      {error === null ? null : (
        <p className="admin-inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function stamp(at: number | null): string {
  return at === null
    ? "data as of —"
    : `data as of ${new Date(at).toLocaleTimeString()}`;
}

function AdminDashboard(props: {
  readonly client: AdminClient;
  readonly overview: AdminOverview;
  readonly refreshOverview: () => void;
  readonly loadedAt: number | null;
}) {
  const [active, setActive] = useState<Panel>("activity");
  const [visited, setVisited] = useState<ReadonlySet<Panel>>(
    () => new Set(["activity"]),
  );
  const [requestedPlayer, setRequestedPlayer] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const { meta, updateStatus } = useMeta();
  const { refreshOverview } = props;

  const reload = () => {
    setReloadToken((current) => current + 1);
    refreshOverview();
  };

  useEffect(() => {
    updateStatus({
      mode: props.overview.mode,
      banner: props.overview.banner,
    });
  }, [props.overview.banner, props.overview.mode, updateStatus]);

  const visit = (panel: Panel) => {
    setActive(panel);
    setVisited((current) => new Set([...current, panel]));
  };

  const inspectPlayer = (address: string) => {
    setRequestedPlayer(address);
    visit("players");
    requestAnimationFrame(() => {
      document
        .getElementById("admin-panel-players")
        ?.scrollIntoView({ block: "start" });
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = PANELS.indexOf(active);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % PANELS.length;
    else if (event.key === "ArrowLeft")
      next = (current - 1 + PANELS.length) % PANELS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PANELS.length - 1;
    else return;
    event.preventDefault();
    const panel = PANELS[next];
    if (panel !== undefined) {
      visit(panel);
      tabs.current[next]?.focus();
    }
  };

  if (meta === null) return <BootSkeleton />;

  const content = (panel: Panel) => {
    if (!visited.has(panel)) {
      return (
        <button
          type="button"
          className="admin-load-panel"
          onClick={() => visit(panel)}
        >
          load {panel} panel ▸
        </button>
      );
    }
    if (panel === "activity") {
      return (
        <ActivityPanel
          client={props.client}
          onPlayer={inspectPlayer}
          reloadToken={reloadToken}
        />
      );
    }
    if (panel === "bonuses") {
      return (
        <BonusesPanel
          client={props.client}
          meta={meta}
          onPlayer={inspectPlayer}
          reloadToken={reloadToken}
        />
      );
    }
    if (panel === "health") {
      return (
        <HealthPanel
          client={props.client}
          overview={props.overview}
          reloadToken={reloadToken}
        />
      );
    }
    if (panel === "games") {
      return (
        <GamesPanel
          client={props.client}
          meta={meta}
          reloadToken={reloadToken}
        />
      );
    }
    if (panel === "players") {
      return (
        <PlayersPanel
          client={props.client}
          requestedPlayer={requestedPlayer}
          onPlayerHandled={() => setRequestedPlayer(null)}
          reloadToken={reloadToken}
        />
      );
    }
    return (
      <ConfigPanel
        client={props.client}
        onChanged={props.refreshOverview}
        reloadToken={reloadToken}
      />
    );
  };

  return (
    <AppShell
      dashboard={true}
      topRight={<span className="badge">OPERATOR</span>}
    >
      <main className="admin-page">
        <header className="admin-title">
          <div>
            <span className="vt">OPERATIONS CONSOLE</span>
            <p>read on open · reload for fresh data</p>
          </div>
          <div className="admin-reload">
            <span className="admin-poll-state">{stamp(props.loadedAt)}</span>
            <button type="button" className="btn mini" onClick={reload}>
              reload ▸
            </button>
          </div>
        </header>
        <PauseControl
          client={props.client}
          overview={props.overview}
          onChanged={props.refreshOverview}
        />
        <div className="admin-tabs" role="tablist" aria-label="admin panels">
          {PANELS.map((panel, index) => (
            <button
              type="button"
              role="tab"
              id={`admin-tab-${panel}`}
              aria-selected={active === panel}
              aria-controls={`admin-panel-${panel}`}
              tabIndex={active === panel ? 0 : -1}
              className={active === panel ? "btn toggled" : "btn"}
              onClick={() => visit(panel)}
              onKeyDown={onTabKeyDown}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              key={panel}
            >
              {panel.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="admin-stack">
          {PANELS.map((panel) => (
            <div
              id={`admin-panel-${panel}`}
              role="tabpanel"
              aria-labelledby={`admin-tab-${panel}`}
              className={
                active === panel
                  ? "admin-panel-slot active"
                  : "admin-panel-slot"
              }
              key={panel}
            >
              {content(panel)}
            </div>
          ))}
        </div>
      </main>
    </AppShell>
  );
}

function AuthorizedAdmin(props: { readonly client: AdminClient }) {
  const state = useAdminOverview(props.client);
  if (state.access === "denied") return <NotFound />;
  if (state.access === "probing") return <BootSkeleton />;
  if (state.access === "error" || state.overview === null) {
    return (
      <AppShell dashboard={true}>
        <div className="empty admin-boot-error">
          <span className="vt">[ ADMIN READ FAILED ]</span>
          <p>{state.error ?? "admin overview unavailable"}</p>
          <button type="button" className="btn" onClick={state.refresh}>
            retry ▸
          </button>
        </div>
      </AppShell>
    );
  }
  return (
    <AdminDashboard
      client={props.client}
      overview={state.overview}
      refreshOverview={state.refresh}
      loadedAt={state.loadedAt}
    />
  );
}

export function AdminRoute(props: { readonly client?: AdminClient }) {
  const { session } = useSession();
  const [client] = useState(() => props.client ?? createAdminClient());
  if (session.status === "probing") return <BootSkeleton />;
  if (session.status === "out") return <NotFound />;
  return <AuthorizedAdmin client={client} />;
}
