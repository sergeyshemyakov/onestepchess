import { describe, it } from "vitest";
import { paymentRailConformanceRows } from "./conformance.js";
import { buildMockHeader, createMockRail } from "./index.js";

describe("PaymentRail conformance: rail-mock", () => {
  for (const row of paymentRailConformanceRows) {
    it(row.name, async () => {
      await row.run(() => ({
        rail: createMockRail(),
        buildHeader: (challenge, nonce) =>
          buildMockHeader({ challenge, from: "CONFORMANCE_PLAYER", nonce }),
      }));
    });
  }
});
