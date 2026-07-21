import type { GameResult } from "../api/schemas.js";

export type Outcome = "won" | "lost" | "draw" | "aborted";

export function outcomeFor(
  result: GameResult,
  yourSide: "white" | "black",
): Outcome {
  if (result === "aborted") return "aborted";
  if (result === "draw") return "draw";
  return result === yourSide ? "won" : "lost";
}

/** Results render as ✓/✗ + brightness, never hue alone (§9). */
export function outcomeGlyph(outcome: Outcome): string {
  switch (outcome) {
    case "won":
      return "✓ won";
    case "lost":
      return "✗ lost";
    case "draw":
      return "= draw";
    case "aborted":
      return "ABORTED — fully refunded";
  }
}
