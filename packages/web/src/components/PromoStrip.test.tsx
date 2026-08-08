import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { PromoStrip } from "./PromoStrip.jsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderStrip(championship: boolean) {
  const client = mockClient({
    getMeta: vi.fn(async () => ({
      ...metaFixture,
      banners: { ...metaFixture.banners, championship },
    })),
  });
  render(
    <Providers client={client}>
      <PromoStrip />
    </Providers>,
  );
}

it("champ_promo_shows_when_enabled_by_admin_config", async () => {
  renderStrip(true);
  expect(await screen.findByTestId("champ-promo")).not.toBeNull();
});

it("champ_promo_hidden_when_disabled_by_admin_config", async () => {
  renderStrip(false);
  await act(async () => {});
  expect(screen.queryByTestId("champ-promo")).toBeNull();
});
