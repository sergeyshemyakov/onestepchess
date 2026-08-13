import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Meta, Move } from "../api/schemas.js";
import { obtainTurnstileToken } from "../auth/turnstile.js";
import { Board } from "../board/Board.jsx";
import { BoardLoop } from "../board/BoardLoop.jsx";
import {
  enPassantCaptures,
  movesTo,
  needsPromotion,
  selectableSquares,
  targetsFor,
} from "../board/moves.js";
import { PromotionPicker } from "../board/PromotionPicker.jsx";
import { isCheck, kingSquare } from "../lib/check.js";
import { parseUci, sideToMove } from "../lib/fen.js";
import {
  formatCountdown,
  formatMicroUsdc,
  nextAtLabel,
} from "../lib/format.js";
import { coachMarksSeen, markCoachMarksSeen, readRef } from "../lib/storage.js";
import { INITIAL_NO_BOARDS_RETRY_SECONDS } from "./machine.js";
import { Timer } from "./Timer.jsx";
import type { PlayFlow } from "./usePlayFlow.js";

// F-W4 rendered as one morphing surface over the hub — no stacked popups.
// D16: FOCUS shows board + side badge + stake chip + timer, nothing else.

function CountdownLine(props: {
  readonly seconds: number;
  readonly onDone?: () => void;
  readonly render: (left: number) => string;
}) {
  const [left, setLeft] = useState(props.seconds);
  useEffect(() => {
    setLeft(props.seconds);
    const tick = setInterval(() => {
      setLeft((current) => {
        if (current <= 1) {
          clearInterval(tick);
          props.onDone?.();
          return 0;
        }
        return current - 1;
      });
    }, 1_000);
    return () => clearInterval(tick);
  }, [props.seconds, props.onDone]);
  return <>{props.render(left)}</>;
}

function StatusDialog(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly closeLabel?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="modalback">
      <div className="modal" role="dialog" aria-modal="true">
        <h3>{props.title}</h3>
        {props.children}
        <div
          className={`modal-actions ${props.action === undefined ? "single" : "pair"}`}
        >
          <button type="button" className="btn mini" onClick={props.onClose}>
            {props.closeLabel ?? "← back"}
          </button>
          {props.action}
        </div>
      </div>
    </div>
  );
}

function NoBoardsDialog(props: {
  readonly retryAfterSeconds: number;
  readonly onAutoRetry: () => void;
  readonly onRetryNow: () => void;
  readonly onClose: () => void;
}) {
  const [retryCoolingDown, setRetryCoolingDown] = useState(true);

  useEffect(() => {
    if (!retryCoolingDown) return;
    const cooldown = window.setTimeout(() => setRetryCoolingDown(false), 1_000);
    return () => window.clearTimeout(cooldown);
  }, [retryCoolingDown]);

  const retryNow = () => {
    if (retryCoolingDown) return;
    setRetryCoolingDown(true);
    props.onRetryNow();
  };

  return (
    <StatusDialog
      title="NO BOARDS"
      onClose={props.onClose}
      action={
        <button
          type="button"
          className={`btn mini pri retry-now${retryCoolingDown ? " cooling" : ""}`}
          disabled={retryCoolingDown}
          onClick={retryNow}
        >
          <span className="retry-icon" aria-hidden="true">
            ↻
          </span>{" "}
          RETRY NOW
        </button>
      }
    >
      <p className="mv no-boards-countdown">
        <CountdownLine
          seconds={props.retryAfterSeconds}
          onDone={props.onAutoRetry}
          render={(left) =>
            `NO BOARDS FREE :: retrying in ${formatCountdown(left)}`
          }
        />
      </p>
      <div className="no-boards-reminders">
        <p>&gt; you can't play different sides in a game</p>
        <p>&gt; you can't play soon after your previous move in a game</p>
        <p>&gt; other humans or bots could be thinking long</p>
        <p>&gt; only bots play in the endspiel</p>
      </div>
    </StatusDialog>
  );
}

export function PlayView(props: {
  readonly flow: PlayFlow;
  readonly meta: Meta;
  readonly onWalletIntent?: () => void;
  readonly acceptedMove?: {
    readonly claimId: string;
    readonly txid: string | null;
  } | null;
}) {
  const { state, send, checkExpiry } = props.flow;
  const { meta } = props;
  const [promotion, setPromotion] = useState<readonly Move[] | null>(null);
  const [coach] = useState(() => !coachMarksSeen());

  useEffect(() => {
    if (state.phase === "FOCUS" && coach) markCoachMarksSeen();
  }, [state.phase, coach]);

  const claim = state.claim;
  const selectable = useMemo(
    () =>
      claim === undefined
        ? new Set<string>()
        : selectableSquares(claim.legalMoves),
    [claim],
  );
  const checkSquare = useMemo(
    () =>
      claim !== undefined && isCheck(claim.fen)
        ? kingSquare(claim.fen, claim.yourSide)
        : null,
    [claim],
  );
  const ep = useMemo(
    () =>
      claim === undefined
        ? null
        : enPassantCaptures(claim.legalMoves, claim.fen),
    [claim],
  );
  const epVictims = useMemo(() => [...(ep?.victims ?? [])], [ep]);
  const epTargets = useMemo(() => [...(ep?.targets ?? [])], [ep]);

  if (state.phase === "IDLE") return null;

  const stakeChip =
    claim === undefined
      ? null
      : claim.demo
        ? "stake $0 · DEMO"
        : `stake ${formatMicroUsdc(claim.stakeMicroUsdc)}`;

  const onSquareTap = (square: string) => {
    if (claim === undefined || state.phase !== "FOCUS") return;
    if (state.selected === null || state.selected === undefined) {
      if (selectable.has(square)) send({ type: "SELECT", square });
      return;
    }
    if (square === state.selected) {
      send({ type: "SELECT", square: null });
      return;
    }
    if (
      selectable.has(square) &&
      targetsFor(claim.legalMoves, state.selected).length === 0
    ) {
      send({ type: "SELECT", square });
      return;
    }
    const candidates = movesTo(claim.legalMoves, state.selected, square);
    if (candidates.length === 0) {
      if (selectable.has(square)) send({ type: "SELECT", square });
      return;
    }
    if (needsPromotion(candidates)) {
      setPromotion(candidates);
      return;
    }
    const move = candidates[0];
    if (move !== undefined) send({ type: "MOVE_CHOSEN", move });
  };

  // Once the move is committed (signing onward) the modal owns the screen —
  // the background board would leak the position below the morph.
  const focusVisible = state.phase === "FOCUS" || state.phase === "CONFIRM";
  const morphVisible =
    state.phase === "RECEIPT"
      ? state.chosenMove === undefined || claim !== undefined
      : (state.phase === "CONFIRM" ||
          state.phase === "SIGNING" ||
          state.phase === "SETTLING") &&
        claim !== undefined &&
        state.chosenMove !== undefined;

  return (
    <div
      className="focuswrap"
      data-testid="play-surface"
      data-phase={state.phase}
    >
      {state.phase === "CLAIMING" ? (
        <p className="console">&gt; matchmaking… finding you a board ▊</p>
      ) : null}

      {state.phase === "GUEST_GATE" ? (
        <GuestGate flow={props.flow} meta={meta} />
      ) : null}

      {state.phase === "GUEST_USED" ? (
        <LoginWall
          message="your one-move demo is already waiting — log in to see how it ends."
          onWalletIntent={props.onWalletIntent}
          onClose={() => send({ type: "ACK" })}
        />
      ) : null}

      {state.phase === "NO_BOARDS" ? (
        <NoBoardsDialog
          retryAfterSeconds={Math.max(
            1,
            Math.ceil(
              state.retryAfterSeconds ?? INITIAL_NO_BOARDS_RETRY_SECONDS,
            ),
          )}
          onAutoRetry={() => send({ type: "RETRY" })}
          onRetryNow={props.flow.retryClaimNow}
          onClose={() => send({ type: "ACK" })}
        />
      ) : null}

      {state.phase === "QUOTA_OUT" ? (
        <StatusDialog title="QUOTA" onClose={() => send({ type: "ACK" })}>
          <p className="mv">OUT OF BOARDS THIS HOUR</p>
          <p className="sub">
            next at {nextAtLabel(state.retryAfterSeconds ?? 3_600)}
          </p>
        </StatusDialog>
      ) : null}

      {state.phase === "PAUSED" ? (
        <StatusDialog title="PAUSED" onClose={() => send({ type: "ACK" })}>
          <p className="sub">
            settlement offline — boards suspended, nothing at risk.
          </p>
        </StatusDialog>
      ) : null}

      {state.phase === "EXPIRED" ? (
        <StatusDialog
          title="TIME"
          closeLabel="back ▸"
          onClose={() => send({ type: "ACK" })}
        >
          <p className="mv">POSITION PASSED ON</p>
          <p className="sub">
            {state.guest === true
              ? "nothing charged. log in to keep playing."
              : "the board went to another player. nothing was charged."}
          </p>
          {state.guest === true ? (
            <OnboardingDoors onWalletIntent={props.onWalletIntent} />
          ) : null}
        </StatusDialog>
      ) : null}

      {focusVisible && claim !== undefined ? (
        <div className="playlab">
          <div>
            <div className="boardwrap">
              <Board
                fen={claim.fen}
                interactive={state.phase === "FOCUS"}
                selected={
                  state.phase === "FOCUS" ? (state.selected ?? null) : null
                }
                legalTargets={
                  state.phase === "FOCUS" &&
                  state.selected !== null &&
                  state.selected !== undefined
                    ? targetsFor(claim.legalMoves, state.selected)
                    : []
                }
                lastMove={
                  state.chosenMove !== undefined
                    ? {
                        from: parseUci(state.chosenMove.uci).from,
                        to: parseUci(state.chosenMove.uci).to,
                      }
                    : null
                }
                checkSquare={checkSquare}
                epVictims={epVictims}
                epTargets={epTargets}
                onSquareTap={onSquareTap}
                coords
              />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="panel">
              <h3>YOUR MOVE</h3>
              <p
                className={`sidebadge${state.phase === "FOCUS" ? " ready-side" : ""}`}
              >
                YOU PLAY {claim.yourSide === "white" ? "WHITE ▣" : "BLACK ▢"}
              </p>
              {checkSquare !== null ? (
                <p className="checkline" role="alert">
                  ⚠ CHECK — your king is under attack
                </p>
              ) : null}
              {state.phase === "FOCUS" ? (
                <p className="console move-prompt">
                  {state.selected === null || state.selected === undefined
                    ? "> tap a piece, then a target"
                    : `> ${state.selected} :: pick a target`}
                  {epTargets.length > 0 ? (
                    <span className="epline">
                      {
                        "\n> en passant available — the dashed pawn can be taken"
                      }
                    </span>
                  ) : (
                    ""
                  )}
                </p>
              ) : null}
              <p style={{ marginTop: 6 }}>
                <span className="chip">{stakeChip}</span>
              </p>
              <p style={{ marginTop: 12 }}>
                <Timer
                  deadline={claim.deadline}
                  revealSeconds={meta.timing.timerRevealSeconds}
                  totalSeconds={meta.timing.claimTtlSeconds.human}
                  onExpire={checkExpiry}
                />
              </p>
              {promotion !== null && state.phase === "FOCUS" ? (
                <PromotionPicker
                  moves={promotion}
                  side={sideToMove(claim.fen)}
                  onPick={(move) => {
                    setPromotion(null);
                    send({ type: "MOVE_CHOSEN", move });
                  }}
                  onCancel={() => setPromotion(null)}
                />
              ) : null}
              {coach && state.phase === "FOCUS" ? (
                <p className="coach">
                  {
                    "> this move is yours\n> the game goes on after\n> you will be notified when it ends"
                  }
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {morphVisible ? (
        <ConfirmMorph
          flow={props.flow}
          meta={meta}
          onWalletIntent={props.onWalletIntent}
          acceptedMove={props.acceptedMove}
        />
      ) : null}
    </div>
  );
}

/** The morph: confirm → (signing) → settling → typed receipt, one surface
 * (mockups M05). Backdrop is deliberately not click-to-close. */
function ConfirmMorph(props: {
  readonly flow: PlayFlow;
  readonly meta: Meta;
  readonly onWalletIntent?: () => void;
  readonly acceptedMove?: {
    readonly claimId: string;
    readonly txid: string | null;
  } | null;
}) {
  const { state, send } = props.flow;
  const claim = state.claim;
  const move = state.chosenMove ?? state.receipt?.move;
  const demo = state.demo;
  const uci = move === undefined ? null : parseUci(move.uci);

  return (
    <div className="modalback">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="morph-title"
      >
        <h3 id="morph-title">
          {state.phase === "RECEIPT" ? "MOVED" : "FINAL MOVE?"}
        </h3>
        {move !== undefined && uci !== null ? (
          <>
            <p className="mv">
              {uci.from}→{uci.to} <span className="dim">({move.san})</span>
            </p>
            {state.phase === "CONFIRM" && claim !== undefined ? (
              <div
                className="confirm-board-loop"
                role="img"
                aria-label={`move animation ${uci.from} to ${uci.to}`}
                data-testid="confirm-move-animation"
              >
                <BoardLoop
                  fen={claim.fen}
                  from={uci.from}
                  to={uci.to}
                  san={move.san}
                  side={claim.yourSide}
                />
              </div>
            ) : null}
          </>
        ) : null}

        {state.phase === "CONFIRM" && claim !== undefined ? (
          <>
            
            {state.error !== null && state.error !== undefined ? (
              <p className="formerr" role="alert">
                {state.error.hint}
              </p>
            ) : null}
            {state.retryAfterSeconds !== undefined && state.error === null ? (
              <p className="sub">
                payment verify unavailable — retry in ~
                {Math.ceil(state.retryAfterSeconds)}s. nothing was charged.
              </p>
            ) : null}
            {demo ? (
              <div className="walletbox">
                <h4>DEMO MOVE</h4>
                <p className="sub">
                  nothing staked — the move still will count.
                </p>
                <div className="modal-actions pair">
                  <button
                    type="button"
                    className="btn pri mini"
                    onClick={() => send({ type: "CONFIRM" })}
                  >
                    Y — make it so
                  </button>
                  <button
                    type="button"
                    className="btn mini"
                    onClick={() => send({ type: "CHANGE_MOVE" })}
                  >
                    N — rethink
                  </button>
                </div>
              </div>
            ) : (
              <div className="walletbox">
                <h4>STAKE &amp; COMMIT</h4>
                <p className="act">
                  <button
                    type="button"
                    className="btn pri sheetbtn"
                    onClick={() => send({ type: "CONFIRM" })}
                  >
                    sign &amp; commit →
                  </button>
                </p>
              </div>
            )}
            <p className="esc">
              <button
                type="button"
                onClick={() => send({ type: "CHANGE_MOVE" })}
              >
                ← change move
              </button>
            </p>
          </>
        ) : null}

        {state.phase === "SIGNING" ? (
          <p className="console">&gt; building payment…</p>
        ) : null}

        {state.phase === "SETTLING" ? (
          demo ? (
            <p className="console">&gt; committing…</p>
          ) : (
            <div className="settling">&nbsp;settling… (~4 s)</div>
          )
        ) : null}

        {props.acceptedMove !== null &&
        props.acceptedMove !== undefined &&
        props.acceptedMove.claimId === claim?.claimId ? (
          <p className="console" data-testid="move-accepted-line">
            &gt; move accepted
          </p>
        ) : null}

        {state.phase === "RECEIPT" && state.receipt !== undefined ? (
          <Receipt flow={props.flow} onWalletIntent={props.onWalletIntent} />
        ) : null}
      </div>
    </div>
  );
}

/** Typed receipt (F-W4): never a game name — a second entry's receipt would
 * correlate two claims to one game (D16). */
function Receipt(props: {
  readonly flow: PlayFlow;
  readonly onWalletIntent?: () => void;
}) {
  const { state, send } = props.flow;
  const receipt = state.receipt;
  if (receipt === undefined) return null;
  const demo = receipt.debitMicroUsdc === 0;
  return (
    <>
      <div className="console" data-testid="receipt">
        {state.guest === true ? (
          <>
            &gt; move played :: {receipt.move.san}
            {"\n"}&gt; the game goes on without you
            {"\n"}&gt; connect an Algorand wallet to see how it ends
          </>
        ) : demo ? (
          <>
            &gt; demo move committed :: {receipt.move.san}
            {"\n"}&gt; nothing staked
          </>
        ) : (
          <>
            &gt; stake {formatMicroUsdc(receipt.debitMicroUsdc)} debited
            {"\n"}&gt; move committed :: {receipt.move.san}
            {"\n"}&gt;{" "}
            {receipt.txid !== null && receipt.explorerUrl !== null ? (
              <a
                href={receipt.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                tx ↗
              </a>
            ) : (
              "settled"
            )}
          </>
        )}
        {state.guest === true ? null : (
          <>{"\n"}&gt; the game plays on without you</>
        )}
      </div>
      {state.guest === true ? (
        <OnboardingDoors onWalletIntent={props.onWalletIntent} />
      ) : (
        <p className="console receipt-notice">
          &gt; you will be notified when the game ends
        </p>
      )}
      <div className="modal-actions single">
        <button
          type="button"
          className="btn mini"
          onClick={() => send({ type: "ACK" })}
        >
          close
        </button>
      </div>
    </>
  );
}

function GuestGate(props: { readonly flow: PlayFlow; readonly meta: Meta }) {
  const { state, send } = props.flow;
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = slot.current;
    if (container === null) return;
    let cancelled = false;
    obtainTurnstileToken(container, props.meta.turnstileSiteKey)
      .then((turnstileToken) => {
        if (!cancelled) {
          const ref = readRef();
          send({
            type: "GUEST_VERIFIED",
            turnstileToken,
            ...(ref === null ? {} : { ref }),
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          send({
            type: "GUEST_GATE_FAILED",
            envelope: {
              error: "TURNSTILE_FAILED",
              hint: "verification failed — retry the demo gate",
              docs: "",
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.meta.turnstileSiteKey, send]);

  return (
    <div className="modalback">
      <div className="modal" role="dialog" aria-modal="true">
        <h3>ONE-MOVE DEMO</h3>
        <p className="sub">verify once, then play — no wallet needed.</p>
        {state.error !== null && state.error !== undefined ? (
          <p className="formerr" role="alert">
            {state.error.hint}
          </p>
        ) : null}
        <div ref={slot} data-testid="guest-turnstile-slot" />
        <div className="modal-actions single">
          <button
            type="button"
            className="btn mini"
            onClick={() => send({ type: "ACK" })}
          >
            ← back
          </button>
        </div>
      </div>
    </div>
  );
}

function LoginWall(props: {
  readonly message: string;
  readonly onWalletIntent?: () => void;
  readonly onClose: () => void;
}) {
  return (
    <StatusDialog title="DEMO WAITING" onClose={props.onClose}>
      <p className="sub">{props.message}</p>
      <OnboardingDoors onWalletIntent={props.onWalletIntent} />
    </StatusDialog>
  );
}

function OnboardingDoors(props: { readonly onWalletIntent?: () => void }) {
  return (
    <div className="modal-actions pair" data-testid="onboarding-doors">
      <button type="button" className="btn pri" onClick={props.onWalletIntent}>
        I have a wallet
      </button>
      <a className="btn" href="/start">
        I don't have one yet
      </a>
    </div>
  );
}
