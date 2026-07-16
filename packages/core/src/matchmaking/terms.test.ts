import { describe, expect, it } from "vitest";
import { gameRulesSchema } from "../config.js";
import { CoreError, type PlayerKind, STARTING_FEN } from "../types.js";
import { claimTerms } from "./terms.js";

const BLACK_TO_MOVE_FEN =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

const NOW = 1_700_000_000_000;
const cfg = gameRulesSchema.parse({});

function terms(
  requesterKind: PlayerKind,
  status: "active" | "endspiel",
  demo: boolean,
  fen = STARTING_FEN,
) {
  return claimTerms({
    game: { fen, status },
    requesterKind,
    demo,
    now: NOW,
    cfg,
  });
}

describe("claimTerms", () => {
  it("covers the {kind} x {phase} x {demo} table", () => {
    expect(terms("human", "active", false)).toEqual({
      side: "white",
      stakeMicroUsdc: cfg.HUMAN_STAKE,
      deadline: NOW + cfg.CLAIM_TTL_HUMAN * 1_000,
    });
    expect(terms("human", "active", true)).toEqual({
      side: "white",
      stakeMicroUsdc: 0,
      deadline: NOW + cfg.CLAIM_TTL_HUMAN * 1_000,
    });
    expect(terms("agent", "active", false)).toEqual({
      side: "white",
      stakeMicroUsdc: cfg.AGENT_STAKE,
      deadline: NOW + cfg.CLAIM_TTL_AGENT * 1_000,
    });
    expect(terms("agent", "endspiel", false)).toEqual({
      side: "white",
      stakeMicroUsdc: cfg.ENDSPIEL_STAKE,
      deadline: NOW + cfg.CLAIM_TTL_ENDSPIEL * 1_000,
    });
    expect(terms("guest", "active", true)).toEqual({
      side: "white",
      stakeMicroUsdc: 0,
      deadline: NOW + cfg.CLAIM_TTL_HUMAN * 1_000,
    });
  });

  it("takes the side from sideToMove(fen)", () => {
    expect(terms("human", "active", false, BLACK_TO_MOVE_FEN).side).toBe(
      "black",
    );
  });

  it("throws CONTRACT when an endspiel claim is requested by a non-agent", () => {
    for (const kind of ["human", "guest"] as const) {
      for (const demo of [false, true]) {
        expect(() => terms(kind, "endspiel", demo)).toThrowError(
          expect.objectContaining({ name: "CoreError", code: "CONTRACT" }),
        );
      }
    }
  });

  it("throws CONTRACT when an agent requests a demo claim", () => {
    expect(() => terms("agent", "active", true)).toThrowError(CoreError);
    expect(() => terms("agent", "active", true)).toThrowError(
      expect.objectContaining({ code: "CONTRACT" }),
    );
  });

  it("throws CONTRACT when a guest requests a non-demo claim", () => {
    expect(() => terms("guest", "active", false)).toThrowError(
      expect.objectContaining({ name: "CoreError", code: "CONTRACT" }),
    );
  });
});
