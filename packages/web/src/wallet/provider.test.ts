import { describe, expect, it } from "vitest";
import { createWalletModule } from "./provider.js";

describe("Release 1 wallet surface", () => {
  it("offers only the development mnemonic provider until branded wallets are certified", () => {
    expect(createWalletModule().listWallets()).toEqual([
      { id: "mnemonic", name: "dev wallet (mnemonic)" },
    ]);
  });
});
