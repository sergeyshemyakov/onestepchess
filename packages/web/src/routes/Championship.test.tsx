import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App, type AuthHandlers } from "../App.jsx";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { Landing } from "./Landing.jsx";

const handlers: AuthHandlers = { onUnauthorized: () => undefined };

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

function loggedOutClient() {
  return mockClient({ probeProfile: vi.fn(async () => null) } as never);
}

function walkFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walkFiles(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

it("championship_teaser_and_stats_follow_feature_contract", async () => {
  // -- /championship is fully static: pinned prize pool and points-based
  //    admission, no server calls beyond the shared shell.
  window.history.replaceState({}, "", "/championship");
  const client = loggedOutClient();
  const page = render(<App client={client} authHandlers={handlers} />);
  const champ = await screen.findByTestId("championship");
  expect(champ.textContent).toContain("150 USDC in prizes");
  expect(champ.textContent).toContain("admission based on points");
  expect(champ.textContent).toContain("format and dates to be announced");
  expect(client.getMeta).toHaveBeenCalledTimes(1);
  expect(client.probeProfile).toHaveBeenCalledTimes(1);
  expect(client.getProfile).not.toHaveBeenCalled();
  expect(client.getReplay).not.toHaveBeenCalled();
  page.unmount();

  // -- Strip dismissal persists across sessions (osc.champNotice).
  const first = render(
    <Providers client={loggedOutClient()}>
      <Landing
        client={loggedOutClient()}
        meta={metaFixture}
        onSignedIn={vi.fn()}
      />
    </Providers>,
  );
  const promo = await screen.findByTestId("champ-promo");
  expect(promo.textContent).toContain("one step chess championship");
  fireEvent.click(
    screen.getByRole("button", { name: "dismiss championship notice" }),
  );
  expect(screen.queryByTestId("champ-promo")).toBeNull();
  expect(localStorage.getItem("osc.champNotice")).toBe("dismissed");
  first.unmount();
  const second = render(
    <Providers client={loggedOutClient()}>
      <Landing
        client={loggedOutClient()}
        meta={metaFixture}
        onSignedIn={vi.fn()}
      />
    </Providers>,
  );
  expect(screen.queryByTestId("champ-promo")).toBeNull();

  // -- Tower teaser is text + link only, and no World Chess brand asset
  //    exists anywhere in the bundle's source tree.
  const teaser = await screen.findByTestId("tower-teaser");
  expect(teaser.querySelector("img")).toBeNull();
  expect(teaser.querySelector("svg")).toBeNull();
  expect(teaser.querySelector("a")).not.toBeNull();
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of walkFiles(src)) {
    expect(file.toLowerCase()).not.toMatch(
      /world[^/]*\.(png|svg|jpe?g|gif|webp|ico)$/,
    );
  }

  // -- Stats strip: absent field → no element, no layout gap.
  expect(second.container.querySelector(".statsstrip")).toBeNull();
  second.unmount();
  render(
    <Providers client={loggedOutClient()}>
      <Landing
        client={loggedOutClient()}
        meta={{
          ...metaFixture,
          stats: {
            humanMoves: 1,
            playersRegistered: 2,
            gamesFinished: 3,
            movesSettled: 4,
          },
        }}
        onSignedIn={vi.fn()}
      />
    </Providers>,
  );
  expect((await screen.findByTestId("stats-strip")).textContent).toContain(
    "1 human moves · 2 wallets · 3 games settled · 4 payments",
  );
});
