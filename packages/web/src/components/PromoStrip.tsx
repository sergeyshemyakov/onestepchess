import { useState } from "react";
import { Link } from "react-router";
import { champNoticeDismissed, dismissChampNotice } from "../lib/storage.js";
import { useMeta } from "../meta/MetaContext.jsx";

/** F-W13 championship promo strip (landing + hub). Dismissal persists in
 * `osc.champNotice` across sessions. Copy is CA-14 (placeholders ship). */
export function PromoStrip() {
  const { meta } = useMeta();
  const [dismissed, setDismissed] = useState(champNoticeDismissed);
  if (meta?.banners.championship !== true || dismissed) return null;
  return (
    <div className="promostrip" data-testid="champ-promo">
      <Link to="/championship">
        ♞ one step chess championship — 150 USDC in prizes · details ▸
      </Link>
      <button
        type="button"
        className="btn mini"
        aria-label="dismiss championship notice"
        onClick={() => {
          dismissChampNotice();
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}
