import { type ReactNode, useCallback, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { AlgorandMark, KnightMark } from "../board/pieces.jsx";
import {
  readClaimDraft,
  readTheme,
  type Theme,
  writeTheme,
} from "../lib/storage.js";
import { useMeta } from "../meta/MetaContext.jsx";
import { ClaimBar } from "./ClaimBar.jsx";
import { useShellLive } from "./ShellLiveContext.js";

const THEME_ORDER: readonly Theme[] = ["green", "amber", "ice"];

export function PhosphorToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  const cycle = useCallback(() => {
    const next =
      THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ??
      "green";
    document.documentElement.dataset.theme = next;
    writeTheme(next);
    setTheme(next);
  }, [theme]);

  return (
    <button
      type="button"
      className="btn mini theme-toggle"
      onClick={cycle}
      aria-label={`phosphor theme: ${theme}`}
    >
      ◐ {theme} ▸
    </button>
  );
}

/** Shell banner: `/meta.status` on load, before any SSE exists (W1). The
 * PAUSED copy is pinned by F-W10. */
export function SystemBanner() {
  const { meta } = useMeta();
  if (meta === null) return null;
  if (meta.status.mode === "paused") {
    return (
      <div className="banner" role="status">
        ▮ settlement offline — boards suspended, nothing at risk.{" "}
        {meta.status.banner ?? "we'll be right back."} ▮
      </div>
    );
  }
  if (meta.status.banner !== null && meta.status.banner !== "") {
    return (
      <div className="banner" role="status">
        ▮ {meta.status.banner} ▮
      </div>
    );
  }
  return null;
}

export function AppShell(props: {
  readonly children: ReactNode;
  readonly topRight?: ReactNode;
  readonly belowBar?: ReactNode;
  /** Public replay is intentionally independent of `/meta` (§6 F-W6). */
  readonly showSystemBanner?: boolean;
}) {
  const live = useShellLive();
  const location = useLocation();
  const navigate = useNavigate();
  const draft = live === null ? readClaimDraft() : null;
  const deadline = live?.currentClaim?.deadline ?? draft?.deadline ?? null;
  const showClaimBar =
    deadline !== null &&
    location.pathname !== "/" &&
    live?.playSurfaceVisible !== true;

  return (
    <div className="crt">
      <div className="overlay scan" />
      <div className="overlay vig" />
      <div className="appbar">
        <Link className="brand" to="/" aria-label="ONE STEP CHESS home">
          <KnightMark />
          ONE STEP CHESS
        </Link>
        <span className="spacer" />
        {live !== null ? (
          <nav className="appnav" aria-label="primary">
            <Link className="chip click" to="/">
              BOARDS
            </Link>
            <Link className="chip click" to="/archive">
              ARCHIVE
            </Link>
          </nav>
        ) : null}
        {live?.connection === "reconnecting" ? (
          <span className="chip reconnect" role="status">
            reconnecting…
          </span>
        ) : null}
        {props.topRight}
        <PhosphorToggle />
        <a
          href="https://algorand.co/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Algorand website"
        >
          <AlgorandMark />
        </a>
      </div>
      {props.belowBar}
      {showClaimBar ? (
        <ClaimBar deadline={deadline} onReturn={() => navigate("/")} />
      ) : null}
      {props.showSystemBanner === false ? null : <SystemBanner />}
      {props.children}
    </div>
  );
}
