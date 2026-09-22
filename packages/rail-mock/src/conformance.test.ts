import { describe, it } from "vitest";
import { paymentRailConformanceRows } from "./conformance.js";
import { buildMockHeader, createMockRail } from "./index.js";

describe("PaymentRail conformance: rail-mock", () => {
  for (const row of paymentRailConformanceRows) {
    it(row.name, async () => {
      await row.run(() => {
        const rail = createMockRail();
        return {
          rail,
          buildHeader: (challenge, nonce) =>
            buildMockHeader({ challenge, from: "CONFORMANCE_PLAYER", nonce }),
          confirmAssetTransfer: async (input) =>
            rail.control.confirmAssetTransfer({
              sender: input.sender,
              receiver: rail.treasuryAddress,
              asset: "31566704",
              amount: input.amount,
              note: input.note,
            }).txid,
        };
      });
    });
  }
});
