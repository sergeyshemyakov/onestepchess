import { type ReactNode, useCallback, useState } from "react";
import { AlgorandMark, KnightMark } from "../board/pieces.jsx";
import { readTheme, type Theme, writeTheme } from "../lib/storage.js";
import { useMeta } from "../meta/MetaContext.jsx";

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
}) {
  return (
    <div className="crt">
      <div className="overlay scan" />
      <div className="overlay vig" />
      <div className="appbar">
        <span className="brand">
          <KnightMark />
          ONE STEP CHESS
        </span>
        <span className="spacer" />
        {props.topRight}
        <PhosphorToggle />
        <AlgorandMark />
      </div>
      {props.belowBar}
      <SystemBanner />
      {props.children}
    </div>
  );
}
