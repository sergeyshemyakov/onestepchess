import { Link } from "react-router";
import { AppShell } from "../components/AppShell.jsx";

/** F-W13 championship announcement — fully static, no server calls beyond
 * the shared shell. Copy is CA-14 (placeholders ship). */
export function Championship() {
  return (
    <AppShell>
      <div className="guide" data-testid="championship">
        <h1 style={{ fontSize: 40 }}>♞ ONE STEP CHESS CHAMPIONSHIP</h1>
        <p className="mv">150 USDC in prizes</p>
        <p className="dim">
          admission based on points — earn points with staked moves, more for
          wins.
        </p>
        <p className="dim">format and dates to be announced.</p>
        <p style={{ marginTop: 16 }}>
          <Link to="/">▸ back to the board</Link>
        </p>
      </div>
    </AppShell>
  );
}
