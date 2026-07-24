import { afterEach, expect, it } from "vitest";
import {
  dismissTowerTeaser,
  TOWER_TEASER_COOLDOWN_MS,
  towerTeaserDismissed,
} from "./storage.js";

afterEach(() => {
  localStorage.clear();
});

it("shows the Tower teaser again after a 24-hour dismissal cooldown", () => {
  const dismissedAt = Date.UTC(2026, 6, 23, 12);
  dismissTowerTeaser(dismissedAt);

  expect(towerTeaserDismissed(dismissedAt + TOWER_TEASER_COOLDOWN_MS - 1)).toBe(
    true,
  );
  expect(towerTeaserDismissed(dismissedAt + TOWER_TEASER_COOLDOWN_MS)).toBe(
    false,
  );
});
