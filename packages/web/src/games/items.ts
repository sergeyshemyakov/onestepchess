import type { FinishedGameItem, FinishedStakedItem } from "../api/schemas.js";

/** The demo flag is authoritative; the field check keeps malformed payloads
 * from exposing identity if a caller bypasses the wire schema. */
export function isFinishedStakedItem(
  item: FinishedGameItem,
): item is FinishedStakedItem {
  return !item.demo && "gameId" in item;
}
