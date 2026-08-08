import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { TowerTeaser } from "./TowerTeaser.jsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderTeaser(tower: boolean) {
  const client = mockClient({
    getMeta: vi.fn(async () => ({
      ...metaFixture,
      banners: { ...metaFixture.banners, tower },
    })),
  });
  render(
    <Providers client={client}>
      <TowerTeaser />
    </Providers>,
  );
}

it("tower_teaser_shows_when_enabled_by_admin_config", async () => {
  renderTeaser(true);
  expect(await screen.findByTestId("tower-teaser")).not.toBeNull();
});

it("tower_teaser_hidden_when_disabled_by_admin_config", async () => {
  renderTeaser(false);
  await act(async () => {});
  expect(screen.queryByTestId("tower-teaser")).toBeNull();
});
