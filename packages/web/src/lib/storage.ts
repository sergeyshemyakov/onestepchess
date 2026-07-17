// The complete storage surface (§4.2 + the §13.6 per-tab coach-mark
// deviation). Nothing else in the app touches Web Storage; signed payment
// headers and JWTs are never stored anywhere.

export type Theme = "green" | "amber" | "ice";

export type ClaimDraft = {
  readonly claimId: string;
  readonly moveUci?: string;
  readonly savedAt: string;
};

const THEME_KEY = "osc.theme";
const SFX_KEY = "osc.sfx";
const DRAFT_KEY = "osc.claimDraft";
const COACH_KEY = "osc.coach";

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
  const value = safeGet(localStorage, THEME_KEY);
  return value === "amber" || value === "ice" ? value : "green";
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
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ClaimDraft).claimId === "string"
    ) {
      return parsed as ClaimDraft;
    }
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
