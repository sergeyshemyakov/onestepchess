import { Link } from "react-router";
import { AppShell } from "../components/AppShell.jsx";

/** One component reused for every unknown surface (§4.1). */
export function NotFound() {
  return (
    <AppShell>
      <div
        style={{ padding: "60px 22px", display: "grid", placeItems: "center" }}
      >
        <div className="empty" style={{ maxWidth: 420 }}>
          <span className="vt">[ NO SIGNAL ]</span>
          nothing at this address.
          <p style={{ marginTop: 10 }}>
            <Link to="/">▸ back to the board</Link>
          </p>
        </div>
      </div>
    </AppShell>
  );
}
