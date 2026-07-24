import { useRef, useState } from "react";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

// F-W12 share sheet — wins only; the entry points (win toast, won staked
// quick-view) are the callers' responsibility. The `ref` param on the built
// URL is the only tracer; there are no client-side share analytics.

/** Pinned share text (CA-14 placeholder until Sergey's copy). */
export const SHARE_TEXT =
  "my one move held up. strangers and machines share every game — i played exactly one of its moves. one step chess, on algorand.";

export function shareUrl(args: {
  readonly origin: string;
  readonly gameId: string;
  readonly yourPly: number;
  readonly refCode: string | null;
}): string {
  const base = `${args.origin}/replay/${args.gameId}?ply=${args.yourPly}`;
  return args.refCode === null || args.refCode === ""
    ? base
    : `${base}&ref=${encodeURIComponent(args.refCode)}`;
}

export function ShareSheet(props: {
  readonly gameId: string;
  readonly yourPly: number;
  readonly refCode: string | null;
  readonly onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, props.onClose);
  const url = shareUrl({
    origin: window.location.origin,
    gameId: props.gameId,
    yourPly: props.yourPly,
    refCode: props.refCode,
  });
  const cardSrc = `/api/v1/games/${props.gameId}/card.png?ply=${props.yourPly}`;
  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="modalback">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal sharesheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        data-testid="share-sheet"
      >
        <h3 id="share-title">SHARE YOUR WIN</h3>
        {imageFailed ? (
          <p className="sub" data-testid="share-card-fallback">
            your win card — one move that held up
          </p>
        ) : (
          <>
            <img
              className="sharecard"
              src={cardSrc}
              alt="your win card — one move that held up"
              onError={() => setImageFailed(true)}
            />
            <a
              className="btn pri sharedownload"
              href={cardSrc}
              download={`one-step-chess-win-${props.gameId}.png`}
            >
              download image to share ⇩
            </a>
          </>
        )}
        <p className="sub sharetext">{SHARE_TEXT}</p>
        <p className="console shareurl" data-testid="share-url">
          {url}
        </p>
        <div className="modal-actions pair">
          {canNativeShare ? (
            <button
              type="button"
              className="btn pri mini"
              onClick={() => {
                navigator.share({ text: SHARE_TEXT, url }).catch(() => {
                  // user dismissed the OS sheet — nothing to do
                });
              }}
            >
              share ▸
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn pri mini"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(`${SHARE_TEXT} ${url}`)
                    .then(() => setCopied(true))
                    .catch(() => undefined);
                }}
              >
                {copied ? "copied ✓" : "copy link"}
              </button>
              <a
                className="btn mini"
                href={`https://x.com/intent/post?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(url)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                post on X ↗
              </a>
            </>
          )}
        </div>
        <div className="modal-actions single">
          <button type="button" className="btn mini" onClick={props.onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}
