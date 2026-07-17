import type { Move } from "../api/schemas.js";
import type { PieceType, Side } from "../lib/fen.js";
import { parseUci } from "../lib/fen.js";
import { PieceGlyph } from "./pieces.jsx";

const LABELS: Record<string, string> = {
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
};

/** Choice among the promotion variants of one from→to pair (§8.2). */
export function PromotionPicker(props: {
  readonly moves: readonly Move[];
  readonly side: Side;
  readonly onPick: (move: Move) => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="walletbox" role="dialog" aria-label="choose promotion">
      <h4>PROMOTE TO</h4>
      <div className="act" style={{ display: "flex", gap: 8 }}>
        {props.moves.map((move) => {
          const promo = parseUci(move.uci).promotion ?? "q";
          return (
            <button
              key={move.uci}
              type="button"
              className="btn mini"
              aria-label={`promote to ${LABELS[promo] ?? promo}`}
              onClick={() => props.onPick(move)}
            >
              <PieceGlyph type={promo as PieceType} side={props.side} />
            </button>
          );
        })}
        <button type="button" className="btn mini" onClick={props.onCancel}>
          ← back
        </button>
      </div>
    </div>
  );
}
