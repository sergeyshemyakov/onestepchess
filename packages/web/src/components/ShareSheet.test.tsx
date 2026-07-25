import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { clearReplayCacheForTests } from "../api/replayCache.js";
import type { FinishedDemoItem, FinishedStakedItem } from "../api/schemas.js";
import { QuickView } from "../games/QuickView.jsx";
import {
  finishedDemoFixture,
  finishedStakedFixture,
  metaFixture,
  mockClient,
  replayFixture,
} from "../test/fixtures.jsx";
import { SHARE_TEXT, ShareSheet, shareUrl } from "./ShareSheet.jsx";
import { ToastProvider, useToasts } from "./Toasts.jsx";

afterEach(() => {
  cleanup();
  clearReplayCacheForTests();
  Reflect.deleteProperty(navigator, "clipboard");
});

function renderQuickView(item: FinishedStakedItem | FinishedDemoItem) {
  const client = mockClient({
    getReplay: vi.fn(async (gameId: string) => replayFixture(gameId)),
  } as never);
  return render(
    <MemoryRouter>
      <QuickView
        client={client}
        item={item}
        meta={metaFixture}
        refCode="gentle-rook-042"
        onClose={() => undefined}
      />
    </MemoryRouter>,
  );
}

function ToastProbe() {
  const { push } = useToasts();
  return (
    <button
      type="button"
      data-testid="fire-win-toast"
      onClick={() =>
        push("your side won — your cent became two", "info", {
          label: "share ▸",
          onClick: () => undefined,
        })
      }
    >
      fire
    </button>
  );
}

it("copy_link_copies_only_the_game_url", () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  render(
    <ShareSheet
      gameId="gm_fin_ok"
      yourPly={5}
      refCode="gentle-rook-042"
      onClose={() => undefined}
    />,
  );
  const url = `${window.location.origin}/replay/gm_fin_ok?ply=5&ref=gentle-rook-042`;

  fireEvent.click(screen.getByRole("button", { name: "copy link" }));

  expect(writeText).toHaveBeenCalledWith(url);
});

it("share_affordances_exist_only_for_owned_staked_wins", async () => {
  // -- Won staked quick-view: share ▸ present.
  const won = renderQuickView(finishedStakedFixture());
  await screen.findByTestId("quick-view");
  expect(screen.getByRole("button", { name: "share ▸" })).not.toBeNull();
  won.unmount();

  // -- Lost, drawn, and demo entries gain no share button (I7 extension).
  for (const item of [
    finishedStakedFixture({ result: "black", payoutMicroUsdc: 0 }),
    finishedStakedFixture({ result: "draw" }),
    finishedDemoFixture({ result: "black" }),
  ]) {
    const view = renderQuickView(item);
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "share ▸" })).toBeNull();
    view.unmount();
  }

  // -- The win toast carries the share entry point.
  const toast = render(
    <ToastProvider>
      <ToastProbe />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByTestId("fire-win-toast"));
  expect(await screen.findByRole("button", { name: "share ▸" })).not.toBeNull();
  toast.unmount();

  // -- Built URL always carries the sharer's current refCode and ply.
  expect(
    shareUrl({
      origin: "https://osc.example",
      gameId: "gm_fin_ok",
      yourPly: 5,
      refCode: "gentle-rook-042",
    }),
  ).toBe("https://osc.example/replay/gm_fin_ok?ply=5&ref=gentle-rook-042");

  // -- The sheet always offers copy link + the X intent.
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const sheet = render(
    <ShareSheet
      gameId="gm_fin_ok"
      yourPly={5}
      refCode="gentle-rook-042"
      onClose={() => undefined}
    />,
  );
  const url = `${window.location.origin}/replay/gm_fin_ok?ply=5&ref=gentle-rook-042`;
  expect(screen.getByTestId("share-url").textContent).toBe(url);
  fireEvent.click(screen.getByRole("button", { name: "copy link" }));
  expect(writeText).toHaveBeenCalledWith(url);
  const xHref = (
    screen.getByRole("link", { name: /share on X/ }) as HTMLAnchorElement
  ).href;
  expect(xHref).toContain("https://x.com/intent/post");
  expect(xHref).toContain(encodeURIComponent(url));
  expect(xHref).toContain(encodeURIComponent(SHARE_TEXT));

  // -- Card-image failure keeps the sheet rendered with alt text.
  fireEvent.error(screen.getByAltText(/your win card/));
  expect(screen.getByTestId("share-card-fallback")).not.toBeNull();
  expect(screen.getByTestId("share-sheet")).not.toBeNull();
  sheet.unmount();
});
