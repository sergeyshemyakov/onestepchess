import type { FinishedGameItem, FinishedStakedItem } from "../api/schemas.js";

/** The demo flag is authoritative; the field check keeps malformed payloads
 * from exposing identity if a caller bypasses the wire schema. */
export function isFinishedStakedItem(
  item: FinishedGameItem,
): item is FinishedStakedItem {
  return !item.demo && "gameId" in item;
}

export function ownedPlies(item: FinishedStakedItem): number[] {
  return item.yourMoves.map((move) => move.ply);
}

export function replayPath(gameId: string, plies: readonly number[]): string {
  return `/replay/${gameId}?plies=${plies.join(",")}`;
}

export function finishedMovesLabel(item: FinishedGameItem): string {
  if (isFinishedStakedItem(item)) {
    if (item.yourMoves.length > 1)
      return `plies ${ownedPlies(item).join(", ")}`;
    const move = item.yourMoves[0];
    return move === undefined ? "" : `${move.san} · ply ${move.ply}`;
  }
  if (item.yourMoves.length === 1) return item.yourMoves[0]?.san ?? "";
  return `${item.yourMoves.length} demo moves`;
}
