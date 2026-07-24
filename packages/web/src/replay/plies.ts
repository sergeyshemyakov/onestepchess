import type { ReplayPly } from "../api/schemas.js";
import { parseUci } from "../lib/fen.js";
import type { ReplayerPly } from "./Replayer.jsx";

export function toReplayerPlies(
  plies: readonly ReplayPly[],
): readonly ReplayerPly[] {
  return plies.map((ply) => {
    const { from, to } = parseUci(ply.move.uci);
    return { fenAfter: ply.fenAfter, from, to };
  });
}
