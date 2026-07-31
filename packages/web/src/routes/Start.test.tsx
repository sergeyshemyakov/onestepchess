import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { Start } from "./Start.jsx";

afterEach(cleanup);

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
});
