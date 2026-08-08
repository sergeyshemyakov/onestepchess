import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resetWalletModuleForTests } from "./lazy.js";
import { PaymentWalletSheet } from "./PaymentWalletSheet.jsx";
import type { WalletModule } from "./provider.js";

const walletModule: WalletModule = {
  listWallets: () => [
    { id: "pera", name: "Pera" },
    { id: "defly", name: "Defly" },
  ],
  connect: vi.fn(),
  current: () => null,
  disconnect: vi.fn(async () => undefined),
};

vi.mock("./provider.js", () => ({
  createWalletModule: () => walletModule,
}));

afterEach(() => {
  cleanup();
  resetWalletModuleForTests();
  vi.clearAllMocks();
});

it("wrong-wallet errors name the address required by the signed-in account", async () => {
  vi.mocked(walletModule.connect).mockResolvedValue({
    address: "WRONG",
    walletName: "Pera",
    signTransactions: vi.fn(),
  });
  render(
    <PaymentWalletSheet
      address="PLAYER"
      caip2="mock:local"
      onConnected={() => undefined}
      onCancel={() => undefined}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: /Pera/ }));

  expect((await screen.findByRole("alert")).textContent).toContain("PLAYER");
});

it("confirm-time wallet choices use the same vertical list as login", async () => {
  render(
    <PaymentWalletSheet
      address="PLAYER"
      caip2="mock:local"
      onConnected={() => undefined}
      onCancel={() => undefined}
    />,
  );

  const pera = await screen.findByRole("button", { name: /Pera/ });
  const actions = pera.closest(".act");
  expect(actions).not.toBeNull();
  expect((actions as HTMLElement).style.flexDirection).toBe("column");
  expect((actions as HTMLElement).style.alignItems).toBe("stretch");
  expect(actions?.children).toHaveLength(2);
});
