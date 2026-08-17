import { useState } from "react";
import { customBannerDismissed, dismissCustomBanner } from "../lib/storage.js";
import { useMeta } from "../meta/MetaContext.jsx";

/** Admin-configured site-wide announcement (`CUSTOM_BANNER_TEXT`). Dismissal
 * persists per message in `osc.customBanner`, so an edited text reappears. */
export function CustomBanner() {
  const { meta } = useMeta();
  const [, setDismissTick] = useState(0);
  const message = meta?.banners.custom ?? "";
  if (message === "" || customBannerDismissed(message)) return null;
  return (
    <div
      className="banner dismissible"
      role="status"
      data-testid="custom-banner"
    >
      <span>▮ {message} ▮</span>
      <button
        type="button"
        className="btn mini"
        aria-label="dismiss announcement"
        onClick={() => {
          dismissCustomBanner(message);
          setDismissTick((tick) => tick + 1);
        }}
      >
        ✕
      </button>
    </div>
  );
}
