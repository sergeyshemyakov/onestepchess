import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toasts.jsx";
import { resetWalletModuleForTests } from "./lazy.js";
import { PaymentWalletSheet } from "./PaymentWalletSheet.jsx";
import type { WalletModule } from "./provider.js";

const walletModule: WalletModule = {
  listWallets: () => [
    { id: "pera", name: "Pera" },
    { id: "defly", name: "Defly" },
    { id: "lute", name: "Lute" },
  ],
  connect: vi.fn(),
  current: () => null,
  disconnect: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
};

vi.mock("./provider.js", () => ({
  createWalletModule: () => walletModule,
}));

afterEach(() => {
  cleanup();
  resetWalletModuleForTests();
  vi.clearAllMocks();
});

function renderSheet() {
  return render(
    <ToastProvider>
      <PaymentWalletSheet
        address="PLAYER"
        caip2="mock:local"
        onConnected={() => undefined}
        onCancel={() => undefined}
      />
    </ToastProvider>,
  );
}

it("wrong-wallet errors name the address required by the signed-in account", async () => {
  vi.mocked(walletModule.connect).mockResolvedValue({
    address: "WRONG",
    walletName: "Pera",
    signTransactions: vi.fn(),
  });
  renderSheet();

  fireEvent.click(await screen.findByRole("button", { name: /Pera/ }));

  expect((await screen.findByRole("alert")).textContent).toContain("PLAYER");
});

it("confirm-time wallet choices use the same vertical list as login", async () => {
  renderSheet();

  const pera = await screen.findByRole("button", { name: /Pera/ });
  const actions = pera.closest(".act");
  expect(actions).not.toBeNull();
  expect((actions as HTMLElement).style.flexDirection).toBe("column");
  expect((actions as HTMLElement).style.alignItems).toBe("stretch");
  expect(actions?.children).toHaveLength(3);
});

it("lute_connect_click_toasts_a_popup_blocker_hint", async () => {
  vi.mocked(walletModule.connect).mockResolvedValue({
    address: "PLAYER",
    walletName: "Lute",
    signTransactions: vi.fn(),
  });
  renderSheet();

  fireEvent.click(await screen.findByRole("button", { name: /Lute/ }));

  expect(
    await screen.findByText(/check your browser's popup blocker/),
  ).not.toBeNull();
});
