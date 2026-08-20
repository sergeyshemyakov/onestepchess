import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { AppShell } from "./AppShell.jsx";

afterEach(cleanup);

it("footer_renders_on_appshell_pages_with_github_x_and_rules_links", async () => {
  render(
    <Providers client={mockClient()}>
      <AppShell>page body</AppShell>
    </Providers>,
  );

  expect(screen.getByTestId("app-footer")).not.toBeNull();
  expect(
    screen.getByText(/built for the x402 global challenge/),
  ).not.toBeNull();
  expect(
    (await screen.findByRole("link", { name: "GitHub ↗" })).getAttribute(
      "href",
    ),
  ).toBe(metaFixture.docs.repo);
  expect(screen.getByRole("link", { name: "X ↗" }).getAttribute("href")).toBe(
    "https://x.com/onestepchess",
  );
  expect(
    screen.getByRole("link", { name: "· rules" }).getAttribute("href"),
  ).toBe("/rules");
});

it("footer_renders_without_meta_provider_on_the_public_replay_shell", () => {
  render(
    <MemoryRouter>
      <AppShell showSystemBanner={false}>replay body</AppShell>
    </MemoryRouter>,
  );

  expect(screen.getByTestId("app-footer")).not.toBeNull();
  expect(screen.getByRole("link", { name: "X ↗" })).not.toBeNull();
  expect(screen.queryByRole("link", { name: "GitHub ↗" })).toBeNull();
});
