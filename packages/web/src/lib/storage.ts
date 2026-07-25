import { z } from "zod";

// The complete storage surface (§4.2 + the §13.6 per-tab coach-mark
// deviation). Nothing else in the app touches Web Storage; signed payment
// headers and JWTs are never stored anywhere.

const themeSchema = z.enum(["green", "amber", "ice"]);
export type Theme = z.infer<typeof themeSchema>;

const claimDraftSchema = z.object({
  claimId: z.string(),
  moveUci: z.string().optional(),
  deadline: z.string().optional(),
  savedAt: z.string(),
});
export type ClaimDraft = z.infer<typeof claimDraftSchema>;

const guestDemoStateSchema = z.enum(["played", "expired"]);
export type GuestDemoState = z.infer<typeof guestDemoStateSchema>;

const THEME_KEY = "osc.theme";
const SFX_KEY = "osc.sfx";
const DRAFT_KEY = "osc.claimDraft";
const COACH_KEY = "osc.coach";
const GUEST_DEMO_KEY = "osc.guestDemo";
const REF_KEY = "osc.ref";
const CHAMP_KEY = "osc.champNotice";
const TOWER_TEASER_KEY = "osc.towerTeaserDismissedAt";
const LAST_SEEN_FINISHED_KEY = "osc.lastSeenFinishedAt";
export const TOWER_TEASER_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: Storage, key: string, value: string | null): void {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // storage may be unavailable (private mode) — every value is optional
  }
}

export function readTheme(): Theme {
  return (
    themeSchema.safeParse(safeGet(localStorage, THEME_KEY)).data ?? "green"
  );
}

export function writeTheme(theme: Theme): void {
  safeSet(localStorage, THEME_KEY, theme);
}

export function readSfx(): boolean {
  return safeGet(localStorage, SFX_KEY) === "on";
}

export function writeSfx(on: boolean): void {
  safeSet(localStorage, SFX_KEY, on ? "on" : "off");
}

/** Per-tab by design (sessionStorage) — multi-tab safe (§4.2). */
export function readClaimDraft(): ClaimDraft | null {
  const raw = safeGet(sessionStorage, DRAFT_KEY);
  if (raw === null) return null;
  try {
    const parsed = claimDraftSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to clearing the corrupt draft
  }
  safeSet(sessionStorage, DRAFT_KEY, null);
  return null;
}

export function writeClaimDraft(draft: ClaimDraft | null): void {
  safeSet(
    sessionStorage,
    DRAFT_KEY,
    draft === null ? null : JSON.stringify(draft),
  );
}

/** First-claim coach marks show once per tab (§13.6). */
export function coachMarksSeen(): boolean {
  return safeGet(sessionStorage, COACH_KEY) === "seen";
}

export function markCoachMarksSeen(): void {
  safeSet(sessionStorage, COACH_KEY, "seen");
}

export function readGuestDemo(): GuestDemoState | null {
  return (
    guestDemoStateSchema.safeParse(safeGet(localStorage, GUEST_DEMO_KEY))
      .data ?? null
  );
}

export function writeGuestDemo(value: GuestDemoState | null): void {
  safeSet(localStorage, GUEST_DEMO_KEY, value);
}

export function readRef(): string | null {
  return safeGet(localStorage, REF_KEY);
}

/** First touch wins — an existing code is never overwritten (F-W13). */
export function writeRefFirstTouch(code: string): void {
  if (safeGet(localStorage, REF_KEY) === null) {
    safeSet(localStorage, REF_KEY, code);
  }
}

export function clearRef(): void {
  safeSet(localStorage, REF_KEY, null);
}

export function champNoticeDismissed(): boolean {
  return safeGet(localStorage, CHAMP_KEY) === "dismissed";
}

export function dismissChampNotice(): void {
  safeSet(localStorage, CHAMP_KEY, "dismissed");
}

export function towerTeaserDismissed(now = Date.now()): boolean {
  const raw = safeGet(localStorage, TOWER_TEASER_KEY);
  if (raw === null) return false;
  const dismissedAt = Number(raw);
  const elapsed = now - dismissedAt;
  if (!Number.isFinite(dismissedAt) || elapsed < 0) {
    safeSet(localStorage, TOWER_TEASER_KEY, null);
    return false;
  }
  return elapsed < TOWER_TEASER_COOLDOWN_MS;
}

export function dismissTowerTeaser(now = Date.now()): void {
  safeSet(localStorage, TOWER_TEASER_KEY, String(now));
}

export function readLastSeenFinishedAt(): string | null {
  return safeGet(localStorage, LAST_SEEN_FINISHED_KEY);
}

export function writeLastSeenFinishedAt(iso: string): void {
  safeSet(localStorage, LAST_SEEN_FINISHED_KEY, iso);
}
