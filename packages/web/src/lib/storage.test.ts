import { afterEach, expect, it } from "vitest";
import {
  dismissTowerTeaser,
  readClaimDraft,
  readGuestDemo,
  readTheme,
  TOWER_TEASER_COOLDOWN_MS,
  towerTeaserDismissed,
} from "./storage.js";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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

it("falls back for invalid enum values stored by older clients", () => {
  localStorage.setItem("osc.theme", "violet");
  localStorage.setItem("osc.guestDemo", "unknown");

  expect(readTheme()).toBe("green");
  expect(readGuestDemo()).toBeNull();
});

it("returns a valid claim draft from session storage", () => {
  const draft = {
    claimId: "clm_1",
    moveUci: "e2e4",
    deadline: "2026-07-24T18:00:00.000Z",
    savedAt: "2026-07-24T17:59:00.000Z",
  };
  sessionStorage.setItem("osc.claimDraft", JSON.stringify(draft));

  expect(readClaimDraft()).toEqual(draft);
});

it("clears a malformed claim draft instead of returning unvalidated data", () => {
  sessionStorage.setItem(
    "osc.claimDraft",
    JSON.stringify({ claimId: 42, savedAt: null }),
  );

  expect(readClaimDraft()).toBeNull();
  expect(sessionStorage.getItem("osc.claimDraft")).toBeNull();
});
