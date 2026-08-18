import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { CustomBanner } from "./CustomBanner.jsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderBanner(custom: string) {
  const client = mockClient({
    getMeta: vi.fn(async () => ({
      ...metaFixture,
      banners: { ...metaFixture.banners, custom },
    })),
  });
  render(
    <Providers client={client}>
      <CustomBanner />
    </Providers>,
  );
}

it("custom_banner_shows_the_admin_configured_message", async () => {
  renderBanner("maintenance sunday 06:00 UTC");
  expect(await screen.findByTestId("custom-banner")).not.toBeNull();
  expect(screen.getByText(/maintenance sunday 06:00 UTC/)).not.toBeNull();
});

it("custom_banner_hidden_when_message_is_empty", async () => {
  renderBanner("");
  await act(async () => {});
  expect(screen.queryByTestId("custom-banner")).toBeNull();
});

it("custom_banner_dismissal_persists_for_the_same_message", async () => {
  renderBanner("old news");
  await screen.findByTestId("custom-banner");
  fireEvent.click(screen.getByLabelText("dismiss announcement"));
  expect(screen.queryByTestId("custom-banner")).toBeNull();

  cleanup();
  renderBanner("old news");
  await act(async () => {});
  expect(screen.queryByTestId("custom-banner")).toBeNull();
});

it("custom_banner_reappears_when_the_message_changes", async () => {
  renderBanner("old news");
  await screen.findByTestId("custom-banner");
  fireEvent.click(screen.getByLabelText("dismiss announcement"));

  cleanup();
  renderBanner("fresh news");
  expect(await screen.findByTestId("custom-banner")).not.toBeNull();
});
