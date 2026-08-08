import { useState } from "react";
import { dismissTowerTeaser, towerTeaserDismissed } from "../lib/storage.js";
import { useMeta } from "../meta/MetaContext.jsx";

export function TowerTeaser() {
  const { meta } = useMeta();
  const [dismissed, setDismissed] = useState(() => towerTeaserDismissed());
  if (meta?.banners.tower !== true || dismissed) return null;

  return (
    <div className="promostrip towerstrip" data-testid="tower-teaser">
      <span>
        coming soon: integration with{" "}
        {/* announcement URL is CA-14 — text + link only, no brand assets (R13) */}
        <a
          href="https://worldchess.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          the tower, world chess's arena on algorand ↗
        </a>
      </span>
      <button
        type="button"
        className="btn mini"
        aria-label="dismiss Tower integration notice"
        onClick={() => {
          dismissTowerTeaser();
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}
