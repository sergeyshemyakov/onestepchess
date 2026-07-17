import { describe, expect, it, vi } from "vitest";
import type { ClaimView } from "../api/schemas.js";
import type { ClaimDraft } from "../lib/storage.js";
import { draftFor, syncDraft } from "./draft.js";
import { initialPlayState, type PlayState } from "./machine.js";

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

const focus: PlayState = { phase: "FOCUS", demo: false, claim, selected: null };
const confirm: PlayState = {
  phase: "CONFIRM",
  demo: false,
  claim,
  chosenMove: { uci: "e2e4", san: "e4" },
  paymentHeader: "SECRET_HEADER_BYTES",
};

describe("draft persistence points (§5.5)", () => {
  it("entering FOCUS writes {claimId, savedAt}", () => {
    const write = vi.fn();
    syncDraft(initialPlayState, focus, write, () => "t1");
    expect(write).toHaveBeenCalledWith({ claimId: "clm_1", savedAt: "t1" });
  });

  it("choosing a move updates the draft with moveUci", () => {
    const write = vi.fn();
    syncDraft(focus, confirm, write, () => "t2");
    expect(write).toHaveBeenCalledWith({
      claimId: "clm_1",
      moveUci: "e2e4",
      savedAt: "t2",
    });
  });

  it("terminal states clear the draft", () => {
    for (const phase of ["RECEIPT", "EXPIRED", "IDLE"] as const) {
      const write = vi.fn();
      syncDraft(confirm, { ...initialPlayState, phase }, write);
      expect(write).toHaveBeenCalledWith(null);
    }
  });

  it("does not rewrite when nothing meaningful changed", () => {
    const write = vi.fn();
    syncDraft(focus, { ...focus, selected: "e2" }, write);
    expect(write).not.toHaveBeenCalled();
  });

  it("the signed payment header never reaches any storage shape", () => {
    const draft = draftFor(confirm, () => "t3") as ClaimDraft;
    expect(JSON.stringify(draft)).not.toContain("SECRET_HEADER_BYTES");
    expect(Object.keys(draft).sort()).toEqual(
      ["claimId", "moveUci", "savedAt"].sort(),
    );
  });
});
