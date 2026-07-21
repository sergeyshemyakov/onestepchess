const MICRO_PER_CENT = 10_000;
const MICRO_PER_DOLLAR = 1_000_000;

function trimmedFixed(
  value: number,
  maxDecimals: number,
  minDecimals = 0,
): string {
  const fixed = value.toFixed(maxDecimals);
  let end = fixed.length;
  while (end > 0 && fixed[end - 1] === "0") end -= 1;
  if (end > 0 && fixed[end - 1] === ".") end -= 1;
  const trimmed = fixed.slice(0, end);
  if (minDecimals === 0) return trimmed;
  const dot = trimmed.indexOf(".");
  const decimals = dot === -1 ? 0 : trimmed.length - dot - 1;
  if (decimals >= minDecimals) return trimmed;
  return value.toFixed(minDecimals);
}

/** §4.5: ≥ 1 ¢ renders in dollar form ($0.01), below in cent form (0.1 ¢). */
export function formatMicroUsdc(microUsdc: number): string {
  if (microUsdc >= MICRO_PER_CENT) {
    return `$${trimmedFixed(microUsdc / MICRO_PER_DOLLAR, 6, 2)}`;
  }
  return `${trimmedFixed(microUsdc / MICRO_PER_CENT, 4)} ¢`;
}

const MICRO_PER_ALGO = 1_000_000;

export function formatMicroAlgo(microAlgo: number): string {
  return `${trimmedFixed(microAlgo / MICRO_PER_ALGO, 6)} ALGO`;
}

/** Thinking time (`claimedAt → movedAt`) for quick-view sheets (F-W5). */
export function formatThinkingTime(
  claimedAtIso: string,
  movedAtIso: string,
): string {
  const seconds = Math.max(
    0,
    Math.round(
      (new Date(movedAtIso).getTime() - new Date(claimedAtIso).getTime()) /
        1_000,
    ),
  );
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Wire timestamps are ISO UTC; render in the viewer's local time — HH:MM
 * for same-day, date + time otherwise (§4.5). */
export function formatLocalTime(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  const hhmm = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  if (sameDay) return hhmm;
  const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
  return `${date} ${hhmm}`;
}

/** "next at HH:MM" from a Retry-After horizon against the local clock. */
export function nextAtLabel(
  retryAfterSeconds: number,
  now: Date = new Date(),
): string {
  const at = new Date(now.getTime() + retryAfterSeconds * 1_000);
  return formatLocalTime(at.toISOString(), now);
}

export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Countdowns always derive from a server deadline vs the local clock at
 * render time — never a client-counted duration (§4.5). */
export function secondsUntil(deadlineIso: string, nowMs: number): number {
  return Math.max(0, (new Date(deadlineIso).getTime() - nowMs) / 1_000);
}
