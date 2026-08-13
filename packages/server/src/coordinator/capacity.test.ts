import { describe, expect, it } from "vitest";
import { agentMayClaim, humanBoardCapacity } from "./capacity.js";

const NOW = 1_000_000;

const active = (hasOpenClaim = false, minNextClaimAt = 0) =>
  ({ status: "active", hasOpenClaim, minNextClaimAt }) as const;
const endspiel = (hasOpenClaim = false, minNextClaimAt = 0) =>
  ({ status: "endspiel", hasOpenClaim, minNextClaimAt }) as const;
const cooling = () => active(false, NOW + 20_000);

describe("human board capacity", () => {
  it("does not count boards inside the ply interval as free for humans", () => {
    const capacity = humanBoardCapacity(
      [cooling(), cooling(), cooling(), active(true)],
      25,
      NOW,
    );

    expect(capacity).toEqual({
      totalBoards: 4,
      freeHumanBoards: 0,
      reservedHumanBoards: 1,
      activeBoardsAvailableToAgents: 0,
    });
    expect(agentMayClaim(active(), capacity)).toBe(false);
  });

  it("holds the last claimable board for humans while the rest cool down", () => {
    const capacity = humanBoardCapacity(
      [active(), cooling(), cooling(), active(true)],
      25,
      NOW,
    );

    expect(capacity.freeHumanBoards).toBe(1);
    expect(capacity.activeBoardsAvailableToAgents).toBe(0);
    expect(agentMayClaim(active(), capacity)).toBe(false);
  });

  it("treats a board as free once its ply interval has elapsed", () => {
    const capacity = humanBoardCapacity(
      [active(false, NOW), active(false, NOW - 1), cooling(), active(true)],
      25,
      NOW,
    );

    expect(capacity.freeHumanBoards).toBe(2);
    expect(agentMayClaim(active(), capacity)).toBe(true);
  });

  it("keeps the ceiling of the configured percentage free after an agent claim", () => {
    const capacity = humanBoardCapacity(
      [
        active(),
        active(),
        active(),
        active(),
        active(true),
        active(true),
        active(true),
        active(true),
      ],
      25,
      NOW,
    );

    expect(capacity).toEqual({
      totalBoards: 8,
      freeHumanBoards: 4,
      reservedHumanBoards: 2,
      activeBoardsAvailableToAgents: 2,
    });
    expect(agentMayClaim(active(), capacity)).toBe(true);

    const atReserve = humanBoardCapacity(
      [
        active(),
        active(),
        active(true),
        active(true),
        active(true),
        active(true),
        active(true),
        active(true),
      ],
      25,
      NOW,
    );
    expect(agentMayClaim(active(), atReserve)).toBe(false);
  });

  it("allows zero to disable the reserve and one hundred to reserve every active board", () => {
    expect(
      agentMayClaim(active(), humanBoardCapacity([active()], 0, NOW)),
    ).toBe(true);
    expect(
      agentMayClaim(active(), humanBoardCapacity([active()], 100, NOW)),
    ).toBe(false);
  });

  it("allows agents to finish endspiel boards even when no board is free for humans", () => {
    const capacity = humanBoardCapacity(
      [endspiel(), active(true), active(true), active(true)],
      25,
      NOW,
    );

    expect(capacity.activeBoardsAvailableToAgents).toBe(0);
    expect(agentMayClaim(endspiel(), capacity)).toBe(true);
    expect(agentMayClaim(active(), capacity)).toBe(false);
  });
});
