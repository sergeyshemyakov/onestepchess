import { describe, expect, it } from "vitest";
import type { ClaimView, MoveReceipt } from "../api/schemas.js";
import {
  INITIAL_NO_BOARDS_RETRY_SECONDS,
  initialPlayState,
  type PlayState,
  playReducer,
} from "./machine.js";

const claim: ClaimView = {
  claimId: "clm_1",
  yourSide: "white",
  phase: "normal",
  demo: false,
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  legalMoves: [{ uci: "e2e4", san: "e4" }],
  stakeMicroUsdc: 10_000,
  deadline: "2026-07-17T14:00:00Z",
};
const demoClaim: ClaimView = { ...claim, demo: true, stakeMicroUsdc: 0 };
const move = { uci: "e2e4", san: "e4" };
const receipt: MoveReceipt = {
  status: "moved",
  move,
  debitMicroUsdc: 10_000,
  txid: "mocktx_1",
  explorerUrl: "https://explorer/tx/mocktx_1",
  fenAfterYourMove: "after",
};
const envelope = { error: "PAYMENT_INVALID", hint: "verify failed", docs: "d" };

function at(phase: string, extra: Partial<PlayState> = {}): PlayState {
  return { ...initialPlayState, phase: phase as PlayState["phase"], ...extra };
}

const focus = at("FOCUS", { claim, selected: null });
const confirm = at("CONFIRM", { claim, chosenMove: move });
const signing = at("SIGNING", { claim, chosenMove: move });
const settling = at("SETTLING", {
  claim,
  chosenMove: move,
  paymentHeader: "hdr",
});

describe("claiming branch (§5.5)", () => {
  it("IDLE + PLAY → CLAIMING (staked and demo)", () => {
    expect(
      playReducer(initialPlayState, { type: "PLAY", demo: false }).phase,
    ).toBe("CLAIMING");
    expect(
      playReducer(initialPlayState, { type: "PLAY", demo: true }).demo,
    ).toBe(true);
  });

  it("CLAIMING + CLAIM_READY → FOCUS carrying the ClaimView", () => {
    const next = playReducer(at("CLAIMING"), { type: "CLAIM_READY", claim });
    expect(next).toMatchObject({ phase: "FOCUS", claim, demo: false });
  });

  it("CLAIMING + 204 NO_BOARDS → NO_BOARDS with retryAfter", () => {
    const next = playReducer(at("CLAIMING"), {
      type: "NO_BOARDS",
      retryAfterSeconds: 19,
    });
    expect(next).toMatchObject({
      phase: "NO_BOARDS",
      retryAfterSeconds: INITIAL_NO_BOARDS_RETRY_SECONDS,
    });
  });

  it("CLAIMING + 429 QUOTA_OUT → QUOTA_OUT with retryAfter", () => {
    const next = playReducer(at("CLAIMING"), {
      type: "QUOTA_OUT",
      retryAfterSeconds: 1800,
    });
    expect(next).toMatchObject({ phase: "QUOTA_OUT", retryAfterSeconds: 1800 });
  });

  it("CLAIMING + 503 PAUSED → PAUSED", () => {
    expect(playReducer(at("CLAIMING"), { type: "PAUSED" }).phase).toBe(
      "PAUSED",
    );
  });

  it("NO_BOARDS auto-retry loops back to CLAIMING", () => {
    const none = at("NO_BOARDS", { demo: true, retryAfterSeconds: 19 });
    expect(playReducer(none, { type: "RETRY" })).toMatchObject({
      phase: "CLAIMING",
      demo: true,
      retryAfterSeconds: 19,
    });
  });

  it("NO_BOARDS accepts a board found by an independent manual recheck", () => {
    const next = playReducer(at("NO_BOARDS", { retryAfterSeconds: 5 }), {
      type: "CLAIM_READY",
      claim,
    });

    expect(next).toMatchObject({ phase: "FOCUS", claim });
  });

  it("NO_BOARDS retries start at five seconds and double after every miss", () => {
    const firstMiss = playReducer(at("CLAIMING"), {
      type: "NO_BOARDS",
      retryAfterSeconds: 1,
    });
    const firstRetry = playReducer(firstMiss, { type: "RETRY" });
    const secondMiss = playReducer(firstRetry, {
      type: "NO_BOARDS",
      retryAfterSeconds: 1,
    });
    const secondRetry = playReducer(secondMiss, { type: "RETRY" });
    const thirdMiss = playReducer(secondRetry, {
      type: "NO_BOARDS",
      retryAfterSeconds: 1,
    });

    expect([
      firstMiss.retryAfterSeconds,
      secondMiss.retryAfterSeconds,
      thirdMiss.retryAfterSeconds,
    ]).toEqual([5, 10, 20]);
  });

  it("NO_BOARDS / QUOTA_OUT / PAUSED ack back to IDLE", () => {
    for (const phase of ["NO_BOARDS", "QUOTA_OUT", "PAUSED"] as const) {
      expect(playReducer(at(phase), { type: "ACK" })).toEqual(initialPlayState);
    }
  });
});

describe("focus and confirm (§5.5)", () => {
  it("FOCUS selection is plain context", () => {
    expect(playReducer(focus, { type: "SELECT", square: "e2" }).selected).toBe(
      "e2",
    );
  });

  it("FOCUS + MOVE_CHOSEN → CONFIRM", () => {
    const next = playReducer(focus, { type: "MOVE_CHOSEN", move });
    expect(next).toMatchObject({ phase: "CONFIRM", chosenMove: move });
  });

  it("← change move returns CONFIRM → FOCUS clearing the chosen move", () => {
    const next = playReducer(confirm, { type: "CHANGE_MOVE" });
    expect(next.phase).toBe("FOCUS");
    expect(next.chosenMove).toBeUndefined();
    expect(next.claim).toEqual(claim);
  });

  it("CONFIRM (staked) → SIGNING; CONFIRM (demo) → SETTLING", () => {
    expect(playReducer(confirm, { type: "CONFIRM" }).phase).toBe("SIGNING");
    const demoConfirm = at("CONFIRM", {
      claim: demoClaim,
      chosenMove: move,
      demo: true,
    });
    expect(playReducer(demoConfirm, { type: "CONFIRM" }).phase).toBe(
      "SETTLING",
    );
  });

  it("desync refresh (ILLEGAL_MOVE) re-enters FOCUS with the fresh claim", () => {
    const fresh = { ...claim, legalMoves: [{ uci: "d2d4", san: "d4" }] };
    const next = playReducer(confirm, {
      type: "CLAIM_REFRESHED",
      claim: fresh,
    });
    expect(next).toMatchObject({ phase: "FOCUS", claim: fresh });
    expect(next.chosenMove).toBeUndefined();
  });
});

describe("signing and settling error branches (F-W10 rows)", () => {
  it("wallet_rejection_and_payment_errors_preserve_claim_and_move", () => {
    const walletRejected = playReducer(signing, { type: "WALLET_REJECTED" });
    expect(walletRejected).toMatchObject({
      phase: "CONFIRM",
      claim,
      chosenMove: move,
    });

    const paymentFailed = playReducer(settling, {
      type: "PAYMENT_FAILED",
      envelope,
    });
    expect(paymentFailed).toMatchObject({
      phase: "CONFIRM",
      claim,
      chosenMove: move,
      error: envelope,
    });
    for (const event of [
      { type: "PAYMENT_PENDING" as const, retryAfterSeconds: 5 },
      { type: "PAYMENT_IN_FLIGHT" as const },
    ]) {
      expect(playReducer(settling, event)).toMatchObject({
        phase: "SETTLING",
        claim,
        chosenMove: move,
        settlePoll: true,
        paymentHeader: "hdr",
      });
    }
    expect(
      playReducer(settling, {
        type: "PAYMENT_UNAVAILABLE",
        retryAfterSeconds: 7,
      }),
    ).toMatchObject({
      phase: "CONFIRM",
      claim,
      chosenMove: move,
      retryAfterSeconds: 7,
    });

    const refreshed = { ...claim, legalMoves: [{ uci: "d2d4", san: "d4" }] };
    for (const _desync of ["ILLEGAL_MOVE", "AMBIGUOUS_MOVE"]) {
      expect(
        playReducer(confirm, { type: "CLAIM_REFRESHED", claim: refreshed }),
      ).toMatchObject({ phase: "FOCUS", claim: refreshed });
    }
    expect(playReducer(confirm, { type: "CLAIM_EXPIRED" })).toMatchObject({
      phase: "EXPIRED",
      demo: false,
    });
  });

  it("wallet-reject returns to CONFIRM with move preserved and claim live", () => {
    const next = playReducer(signing, { type: "WALLET_REJECTED" });
    expect(next).toMatchObject({ phase: "CONFIRM", chosenMove: move, claim });
  });

  it("HEADER_READY carries the signed header into SETTLING (memory only)", () => {
    const next = playReducer(signing, { type: "HEADER_READY", header: "hdr" });
    expect(next).toMatchObject({ phase: "SETTLING", paymentHeader: "hdr" });
  });

  it("202 PAYMENT_PENDING stays SETTLING with poll on — never re-sign", () => {
    const next = playReducer(settling, {
      type: "PAYMENT_PENDING",
      retryAfterSeconds: 5,
    });
    expect(next).toMatchObject({
      phase: "SETTLING",
      settlePoll: true,
      paymentHeader: "hdr",
    });
  });

  it("409 PAYMENT_IN_FLIGHT stays SETTLING keeping the exact header for resend", () => {
    const next = playReducer(settling, { type: "PAYMENT_IN_FLIGHT" });
    expect(next).toMatchObject({
      phase: "SETTLING",
      settlePoll: true,
      paymentHeader: "hdr",
    });
  });

  it("402 verify/settle failure → CONFIRM with the envelope hint, claim ticking", () => {
    const next = playReducer(settling, { type: "PAYMENT_FAILED", envelope });
    expect(next).toMatchObject({ phase: "CONFIRM", error: envelope, claim });
    expect(next.paymentHeader).toBeUndefined();
  });

  it("503 PAYMENT_UNAVAILABLE → CONFIRM with Retry-After, definitively uncharged", () => {
    const next = playReducer(settling, {
      type: "PAYMENT_UNAVAILABLE",
      retryAfterSeconds: 7,
    });
    expect(next).toMatchObject({ phase: "CONFIRM", retryAfterSeconds: 7 });
    expect(next.paymentHeader).toBeUndefined();
  });

  it("SETTLING + RECEIPT → RECEIPT and the header leaves memory", () => {
    const next = playReducer(settling, { type: "RECEIPT", receipt });
    expect(next).toMatchObject({ phase: "RECEIPT", receipt });
    expect(next.paymentHeader).toBeUndefined();
  });
});

describe("expiry (410 / status poll is authoritative — timer is cosmetic)", () => {
  it("FOCUS/CONFIRM/SIGNING/SETTLING + CLAIM_EXPIRED → EXPIRED", () => {
    for (const state of [focus, confirm, signing, settling]) {
      expect(playReducer(state, { type: "CLAIM_EXPIRED" }).phase).toBe(
        "EXPIRED",
      );
    }
  });

  it("timer expiry alone does not transition — no reducer event exists for it", () => {
    // The deadline passing produces no dispatch; only the server's 410 or
    // status result does. Feeding any non-expiry event at 0:00 keeps state.
    expect(playReducer(focus, { type: "SELECT", square: "a1" }).phase).toBe(
      "FOCUS",
    );
  });

  it("EXPIRED + ACK → IDLE, RECEIPT + ACK → IDLE", () => {
    expect(playReducer(at("EXPIRED"), { type: "ACK" })).toEqual(
      initialPlayState,
    );
    expect(playReducer(at("RECEIPT", { receipt }), { type: "ACK" })).toEqual(
      initialPlayState,
    );
  });
});
