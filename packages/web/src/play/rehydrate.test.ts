import { describe, expect, it, vi } from "vitest";
import type { ClaimStatus, ClaimView, MoveReceipt } from "../api/schemas.js";
import { decideRehydration, rehydrate } from "./rehydrate.js";

const claim: ClaimView = {
  claimId: "clm_1",
  yourSide: "white",
  phase: "normal",
  demo: false,
  fen: "fen",
  legalMoves: [{ uci: "e2e4", san: "e4" }],
  stakeMicroUsdc: 10_000,
  deadline: "2026-07-17T14:00:00Z",
};
const receipt: MoveReceipt = {
  status: "moved",
  move: { uci: "e2e4", san: "e4" },
  debitMicroUsdc: 10_000,
  txid: "tx",
  explorerUrl: "url",
  fenAfterYourMove: "after",
};
const draft = { claimId: "clm_1", savedAt: "t" };
const draftWithMove = { ...draft, moveUci: "e2e4" };
const open = (paymentState: "verifying" | "settling" | null): ClaimStatus => ({
  status: "open",
  claim,
  paymentState,
});

describe("rehydration decision table (§5.5)", () => {
  it("current 200 × no draft move → FOCUS", () => {
    expect(decideRehydration({ current: claim, draft })).toMatchObject({
      phase: "FOCUS",
      claim,
    });
  });

  it("current 200 × matching draft move → CONFIRM with the move restored", () => {
    expect(
      decideRehydration({ current: claim, draft: draftWithMove }),
    ).toMatchObject({ phase: "CONFIRM", chosenMove: { uci: "e2e4" } });
  });

  it("current 200 × draft for another claim → FOCUS (mismatch ignored)", () => {
    expect(
      decideRehydration({
        current: claim,
        draft: { claimId: "clm_other", moveUci: "e2e4", savedAt: "t" },
      }),
    ).toMatchObject({ phase: "FOCUS" });
  });

  it("current 200 × stale draft move no longer legal → FOCUS", () => {
    expect(
      decideRehydration({
        current: claim,
        draft: { ...draft, moveUci: "a2a3" },
      }),
    ).toMatchObject({ phase: "FOCUS" });
  });

  it("current 404 × no draft → IDLE", () => {
    expect(decideRehydration({ current: null, draft: null }).phase).toBe(
      "IDLE",
    );
  });

  it("current 404 × draft × status verifying/settling → SETTLING + poll", () => {
    for (const state of ["verifying", "settling"] as const) {
      expect(
        decideRehydration({
          current: null,
          draft: draftWithMove,
          status: open(state),
        }),
      ).toMatchObject({ phase: "SETTLING", settlePoll: true });
    }
  });

  it("current 404 × draft × status moved → durable receipt", () => {
    expect(
      decideRehydration({
        current: null,
        draft: draftWithMove,
        status: { status: "moved", receipt },
      }),
    ).toMatchObject({ phase: "RECEIPT", receipt });
  });

  it("current 404 × draft × status open → FOCUS/CONFIRM per draft", () => {
    expect(
      decideRehydration({ current: null, draft, status: open(null) }),
    ).toMatchObject({ phase: "FOCUS" });
    expect(
      decideRehydration({
        current: null,
        draft: draftWithMove,
        status: open(null),
      }),
    ).toMatchObject({ phase: "CONFIRM" });
  });

  it("current 404 × draft × status expired → EXPIRED", () => {
    expect(
      decideRehydration({
        current: null,
        draft: draftWithMove,
        status: { status: "expired" },
      }),
    ).toMatchObject({ phase: "EXPIRED" });
  });

  it("current 404 × unknown draft claim → IDLE", () => {
    expect(
      decideRehydration({ current: null, draft: draftWithMove, status: null }),
    ).toMatchObject({ phase: "IDLE" });
  });
});

describe("rehydration runner (§5.5, #31 one-call restore)", () => {
  it("FOCUS/CONFIRM restore costs exactly one GET /claims/current", async () => {
    const getCurrentClaim = vi.fn(async () => claim);
    const getClaimStatus = vi.fn();
    const state = await rehydrate(
      { getCurrentClaim, getClaimStatus },
      draftWithMove,
    );
    expect(state).toMatchObject({
      phase: "CONFIRM",
      chosenMove: { uci: "e2e4" },
    });
    expect(getCurrentClaim).toHaveBeenCalledTimes(1);
    expect(getClaimStatus).not.toHaveBeenCalled();
  });

  it("reload-during-settlement with a lost header lands in the poll-only path", async () => {
    // The memory-only header is gone; the runner consults the status
    // endpoint and never reconstructs or re-signs anything.
    const getCurrentClaim = vi.fn(async () => null);
    const getClaimStatus = vi.fn(async () => open("settling"));
    const state = await rehydrate(
      { getCurrentClaim, getClaimStatus },
      draftWithMove,
    );
    expect(state).toMatchObject({ phase: "SETTLING", settlePoll: true });
    expect(state.paymentHeader).toBeUndefined();
    expect(getClaimStatus).toHaveBeenCalledWith("clm_1");
  });
});
