import type { Meta } from "../api/schemas.js";

/** F-W13 stats strip: renders only when `/meta` carries `stats` — an absent
 * field leaves no element and no layout gap. */
export function StatsStrip(props: { readonly meta: Meta }) {
  const stats = props.meta.stats;
  if (stats === undefined) return null;
  return (
    <p className="statsstrip" data-testid="stats-strip">
      {stats.humanMoves} human moves · {stats.playersRegistered} wallets ·{" "}
      {stats.gamesFinished} games settled · {stats.movesSettled} payments
    </p>
  );
}
