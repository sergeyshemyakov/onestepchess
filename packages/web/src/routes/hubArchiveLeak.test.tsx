import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clearReplayCacheForTests } from "../api/replayCache.js";
import {
  finishedDemoFixture,
  finishedStakedFixture,
  metaFixture,
  mockClient,
  ongoingItemFixture,
  Providers,
  playerFixture,
  replayFixture,
} from "../test/fixtures.jsx";
import { assertNoGameIdentity } from "../test/leak.js";
import { Archive } from "./Archive.jsx";
import { Hub } from "./Hub.jsx";

// Seeds a payload regression might deliver: ongoing entries and demo cards
// must never surface them, in the DOM or in request traffic (I7 defense in
// depth — the wire schema already strips them, so they are injected past
// the schema here).
const identitySeeds = [
  "gm_leak_ongoing",
  "leaky-game-name",
  "gm_leak_demo",
  "demo-game-name",
  "4242",
];

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  clearReplayCacheForTests();
});

function leakyClient() {
  const ongoingLeaky = {
    ...ongoingItemFixture(),
    gameId: "gm_leak_ongoing",
    gameName: "leaky-game-name",
    yourPly: 4242,
  };
  const ongoingDemo = {
    ...ongoingItemFixture({
      demo: true,
      stakeMicroUsdc: 0,
      payTxid: null,
      yourMove: { uci: "d2d4", san: "d4" },
    }),
    gameId: "gm_leak_ongoing",
  };
  const finishedDemoLeaky = {
    ...finishedDemoFixture(),
    gameId: "gm_leak_demo",
    gameName: "demo-game-name",
    finalFen: "8/8/8/8/8/8/8/8 w - - 0 1",
    yourPly: 4242,
  };
  return mockClient({
    getOngoingGames: vi.fn(async () => ({
      items: [ongoingLeaky, ongoingDemo],
      page: 1,
      pageCount: 1,
      total: 2,
    })),
    getFinishedGames: vi.fn(async () => ({
      items: [finishedStakedFixture(), finishedDemoLeaky],
      page: 1,
      pageCount: 1,
      total: 2,
    })),
    getReplay: vi.fn(async (gameId: string) => replayFixture(gameId)),
  } as never);
}

it("hub_and_archive_never_correlate_ongoing_or_demo_games", async () => {
  // -- Hub active pane: only the latest hero renders, with no identity.
  const client = leakyClient();
  const hub = render(
    <Providers client={client}>
      <Hub client={client} meta={metaFixture} player={playerOf()} />
    </Providers>,
  );
  await screen.findByTestId("active-hero");
  expect(screen.queryByTestId("active-minicard")).toBeNull();
  assertNoGameIdentity(hub.container, identitySeeds);

  // -- Hub finished pane: only the staked hero labels its game by public id;
  //    older demo entries remain available in the archive.
  fireEvent.click(screen.getByRole("tab", { name: "LAST FINISHED" }));
  await screen.findByTestId("finished-hero");
  expect(screen.getByText("Game fin_ok")).not.toBeNull();
  expect(screen.queryByTestId("finished-demo-minicard")).toBeNull();
  assertNoGameIdentity(hub.container, identitySeeds);
  hub.unmount();

  // -- Reload renders identically from the wire payloads alone.
  const rehub = render(
    <Providers client={client}>
      <Hub client={client} meta={metaFixture} player={playerOf()} />
    </Providers>,
  );
  await screen.findByTestId("active-hero");
  assertNoGameIdentity(rehub.container, identitySeeds);
  rehub.unmount();

  // -- Archive cards, demo cards, and the demo quick-view leak nothing.
  const archive = render(
    <Providers client={client}>
      <Archive client={client} meta={metaFixture} player={playerFixture} />
    </Providers>,
  );
  const rows = await screen.findAllByTestId("active-card");
  expect(rows).toHaveLength(2);
  await screen.findByTestId("finished-demo-card");
  assertNoGameIdentity(archive.container, identitySeeds);
  fireEvent.click(screen.getByTestId("finished-demo-card"));
  await screen.findByTestId("quick-view-demo");
  expect(screen.getByText(/replay locked for demo moves/)).not.toBeNull();
  assertNoGameIdentity(archive.container, identitySeeds);

  // -- Request leak check: replays were only ever fetched for the staked
  //    finished game — never for ongoing or demo entries.
  const replayCalls = (client.getReplay as ReturnType<typeof vi.fn>).mock.calls;
  for (const call of replayCalls) {
    expect(call[0]).toBe("gm_fin_ok");
  }
  const allRequestArgs = JSON.stringify(
    Object.values(client).flatMap((fn) =>
      typeof fn === "function" && "mock" in fn
        ? (fn as ReturnType<typeof vi.fn>).mock.calls
        : [],
    ),
  );
  for (const seed of identitySeeds) {
    expect(allRequestArgs).not.toContain(seed);
  }
});

function playerOf() {
  return {
    address: "PLAYERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    kind: "human" as const,
    nickname: "night-owl",
    createdAt: "2026-07-01T00:00:00Z",
  };
}
