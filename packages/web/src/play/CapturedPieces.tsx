import { PieceGlyph } from "../board/pieces.jsx";
import { capturedPieces, type PieceType, type Side } from "../lib/fen.js";

const PIECE_NAMES: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

function CaptureRow(props: {
  readonly label: string;
  readonly spokenLabel: string;
  readonly pieces: readonly PieceType[];
  readonly pieceSide: Side;
  readonly testId: string;
}) {
  const summary =
    props.pieces.length === 0
      ? "no captures"
      : props.pieces.map((type) => PIECE_NAMES[type]).join(", ");
  return (
    <div className="capture-row" data-testid={props.testId}>
      <span className="sr-only">{`${props.spokenLabel} captured: ${summary}`}</span>
      <span className="capture-label" aria-hidden="true">
        {props.label}
      </span>
      {props.pieces.length === 0 ? (
        <span className="capture-empty" aria-hidden="true">
          —
        </span>
      ) : (
        <span className="capture-glyphs" aria-hidden="true">
          {props.pieces.map((type, index) => (
            <PieceGlyph
              key={`${type}-${
                // biome-ignore lint/suspicious/noArrayIndexKey: duplicates are inherent (e.g. two pawns) and the list is tiny and append-only per render
                index
              }`}
              type={type}
              side={props.pieceSide}
            />
          ))}
        </span>
      )}
    </div>
  );
}

/** Captured material grouped by captor, computed from the claim FEN alone —
 * the server exposes no move history (fog of war), so promotions show as a
 * captured pawn (see `capturedPieces`). */
export function CapturedPieces(props: {
  readonly fen: string;
  readonly yourSide: Side;
}) {
  const oppSide: Side = props.yourSide === "white" ? "black" : "white";
  const yourCaptures = capturedPieces(props.fen, oppSide);
  const oppCaptures = capturedPieces(props.fen, props.yourSide);
  return (
    <div className="captures" data-testid="captured-pieces">
      <CaptureRow
        label={`YOU ${props.yourSide === "white" ? "▣" : "▢"}`}
        spokenLabel="you"
        pieces={yourCaptures}
        pieceSide={oppSide}
        testId="captures-you"
      />
      <CaptureRow
        label={`OPP ${oppSide === "white" ? "▣" : "▢"}`}
        spokenLabel="opponent"
        pieces={oppCaptures}
        pieceSide={props.yourSide}
        testId="captures-opp"
      />
    </div>
  );
}
