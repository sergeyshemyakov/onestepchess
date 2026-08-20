import { Link } from "react-router";
import { AlgorandMark } from "../board/pieces.jsx";
import { useMetaOptional } from "../meta/MetaContext.jsx";

/** Shared page footer, rendered by AppShell on every page. Meta is optional
 * because the public replay mounts outside MetaProvider (§6 F-W6) — the
 * GitHub link simply drops there. */
export function Footer() {
  const repo = useMetaOptional()?.meta?.docs.repo;
  return (
    <footer className="appfoot" data-testid="app-footer">
      <div className="appfoot-side">
        <a
          href="https://algorand.co/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Algorand website"
        >
          <AlgorandMark /> RUNS ON ALGORAND
        </a>
      </div>
      <span>· built for the x402 global challenge</span>
      <div className="appfoot-side right">
        {repo === undefined ? null : (
          <a href={repo} target="_blank" rel="noopener noreferrer">
            GitHub ↗
          </a>
        )}
        <a
          href="https://x.com/onestepchess"
          target="_blank"
          rel="noopener noreferrer"
        >
          X ↗
        </a>
        <Link to="/rules">· rules</Link>
      </div>
    </footer>
  );
}
