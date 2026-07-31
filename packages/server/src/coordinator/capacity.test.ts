import { describe, expect, it } from "vitest";
import { agentMayClaim, humanBoardCapacity } from "./capacity.js";

const active = (hasOpenClaim = false) =>
  ({ status: "active", hasOpenClaim }) as const;
const endspiel = (hasOpenClaim = false) =>
  ({ status: "endspiel", hasOpenClaim }) as const;

describe("human board capacity", () => {
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
    );
    expect(agentMayClaim(active(), atReserve)).toBe(false);
  });

  it("allows zero to disable the reserve and one hundred to reserve every active board", () => {
    expect(agentMayClaim(active(), humanBoardCapacity([active()], 0))).toBe(
      true,
    );
    expect(agentMayClaim(active(), humanBoardCapacity([active()], 100))).toBe(
      false,
    );
  });

  it("allows agents to finish endspiel boards even when no board is free for humans", () => {
    const capacity = humanBoardCapacity(
      [endspiel(), active(true), active(true), active(true)],
      25,
    );

    expect(capacity.activeBoardsAvailableToAgents).toBe(0);
    expect(agentMayClaim(endspiel(), capacity)).toBe(true);
    expect(agentMayClaim(active(), capacity)).toBe(false);
  });
});
