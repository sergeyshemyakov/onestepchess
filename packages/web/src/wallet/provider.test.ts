import algosdk from "algosdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWalletModule } from "./provider.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Release 1 wallet surface", () => {
  it("offers only the development mnemonic provider until branded wallets are certified", () => {
    expect(createWalletModule().listWallets()).toEqual([
      { id: "mnemonic", name: "dev wallet (mnemonic)" },
    ]);
  });

  it("invalid mnemonic input explains the error and remains retryable", async () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const prompt = vi
      .fn<(_: string) => string | null>()
      .mockReturnValueOnce("not a mnemonic")
      .mockReturnValueOnce(`  ${mnemonic.replaceAll(" ", "   ")}  `);
    vi.stubGlobal("prompt", prompt);

    const wallet = await createWalletModule().connect("mnemonic");

    expect(wallet.address).toBe(account.addr.toString());
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      "That mnemonic is invalid. Enter a valid 25-word mnemonic passphrase:",
    );
    expect(localStorage.getItem("@txnlab/use-wallet:v4_mnemonic")).toBe(
      mnemonic,
    );
  });

  it("removes a persisted invalid mnemonic before the wallet can reuse it", () => {
    localStorage.setItem("@txnlab/use-wallet:v4_mnemonic", "not a mnemonic");

    createWalletModule();

    expect(localStorage.getItem("@txnlab/use-wallet:v4_mnemonic")).toBeNull();
  });
});
