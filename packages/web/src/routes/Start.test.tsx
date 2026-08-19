import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { resetWalletModuleForTests } from "../wallet/lazy.js";
import { Start } from "./Start.jsx";

vi.mock("../wallet/provider.js", () => ({
  createWalletModule: () => ({
    resume: async () => undefined,
    current: () => null,
    listWallets: () => [{ id: "lute", name: "Lute" }],
    connect: vi.fn(() => new Promise<never>(() => undefined)),
    disconnect: async () => undefined,
  }),
}));

afterEach(() => {
  cleanup();
  resetWalletModuleForTests();
});

it("setup_guide_centers_its_copy_and_links_supported_algorand_wallets", () => {
  const client = mockClient();
  const view = render(
    <Providers client={client}>
      <Start client={client} meta={metaFixture} onSignedIn={vi.fn()} />
    </Providers>,
  );

  expect(view.container.querySelector(".guide")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "GET SET UP" })).not.toBeNull();
  expect(
    screen.getByText(
      /five steps from zero to your first move\. a single cent is enough to play\./,
    ),
  ).not.toBeNull();
  expect(
    screen.getByRole("link", { name: "Pera ↗" }).getAttribute("href"),
  ).toBe("https://perawallet.app/");
  expect(
    screen.getByRole("link", { name: "Defly ↗" }).getAttribute("href"),
  ).toBe("https://defly.app/");
  expect(
    screen.getByRole("link", { name: "Lute ↗" }).getAttribute("href"),
  ).toBe("https://lute.app/");
  expect(
    screen.getByText(
      /Lute runs in a browser and does not require installing any software\. Pera is the easiest on a phone\./,
    ),
  ).not.toBeNull();
});

it("guide_step_one_offers_lute_quick_setup", async () => {
  const client = mockClient();
  render(
    <Providers client={client}>
      <Start client={client} meta={metaFixture} onSignedIn={vi.fn()} />
    </Providers>,
  );

  // Same door as the post-demo QUICK SETUP: lute.app opens in a new tab and
  // the single-Lute connect prompt takes over the sheet.
  const quick = screen.getByRole("link", { name: /QUICK SETUP WITH LUTE/ });
  expect(quick.getAttribute("href")).toBe("https://lute.app/");
  expect(quick.getAttribute("target")).toBe("_blank");
  fireEvent.click(quick);

  const sheet = await screen.findByRole("dialog", { name: "connect wallet" });
  expect(
    within(sheet).getByText(/create a new Lute wallet and connect/),
  ).not.toBeNull();
  expect(
    within(sheet).getByRole("button", { name: /CONNECT WITH LUTE/ }),
  ).not.toBeNull();
});
