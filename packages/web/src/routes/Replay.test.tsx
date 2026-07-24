import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { App, type AuthHandlers } from "../App.jsx";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import { clearReplayCacheForTests } from "../api/replayCache.js";
import { replayFixture } from "../test/fixtures.jsx";
import { Replay } from "./Replay.jsx";

const handlers: AuthHandlers = { onUnauthorized: () => undefined };

afterEach(() => {
  cleanup();
  clearReplayCacheForTests();
  window.history.replaceState({}, "", "/");
});

/** The public page must never touch authenticated endpoints — every other
 * client method throws on call. */
function publicOnlyClient(
  getReplay: (gameId: string) => Promise<ReturnType<typeof replayFixture>>,
): ApiClient {
  const forbidden = () => {
    throw new Error("public replay called an authenticated endpoint");
  };
  return {
    getMeta: forbidden,
    getReplay: vi.fn(getReplay),
    authChallenge: forbidden,
    authVerify: forbidden,
    authLogout: forbidden,
    suggestNickname: forbidden,
    probeProfile: forbidden,
    getProfile: forbidden,
    renameProfile: forbidden,
    getOngoingGames: forbidden,
    getFinishedGames: forbidden,
    createClaim: forbidden,
    getCurrentClaim: forbidden,
    getClaimStatus: forbidden,
    postMove: forbidden,
  } as unknown as ApiClient;
}

function renderReplay(client: ApiClient, entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/replay/:gameId" element={<Replay client={client} />} />
      </Routes>
    </MemoryRouter>,
  );
}

it("replay_heading_and_actions_are_centered_with_the_board", async () => {
  const client = publicOnlyClient(async () => replayFixture("gm_uljwmk6itj34"));
  renderReplay(client, "/replay/gm_uljwmk6itj34");

  const heading = await screen.findByRole("heading", {
    name: "Game uljwmk6itj34",
  });
  const boardColumn = heading.closest(".replayboardcol");
  expect(boardColumn).not.toBeNull();
  expect(boardColumn?.querySelector('[data-testid="replayer"]')).not.toBeNull();

  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../styles/components.css"),
    "utf8",
  );
  expect(css).toMatch(
    /\.replayhead \{[^}]*padding-bottom: 18px;[^}]*text-align: center;/s,
  );
  expect(css).toMatch(/\.replayfoot \{[^}]*justify-content: center;/s);
});

it("public_replay_is_session_free_scrubbable_and_downloads_exact_pgn", async () => {
  // -- 300 plies, fenAfter-indexed; one public request renders everything.
  const replay = replayFixture("gm_300", 300);
  const firstPly = replay.plies[0];
  if (firstPly === undefined) throw new Error("fixture has no plies");
  replay.plies[0] = {
    ...firstPly,
    author: { ...firstPly.author, nickname: null },
  };
  const client = publicOnlyClient(async () => replay);
  window.history.replaceState({}, "", "/replay/gm_300");
  const view = render(<App client={client} authHandlers={handlers} />);
  await screen.findByTestId("replay-page");
  expect(client.getReplay).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText(/^M\d+$/)).toHaveLength(300);
  expect(screen.getByText("anonymous")).not.toBeNull();

  // -- Scrubbing is indexed: ply 150's queen file is (150-1)%8 = 5 → f8.
  const scrub = screen.getByLabelText("scrub plies") as HTMLInputElement;
  fireEvent.change(scrub, { target: { value: "150" } });
  const board = screen.getByTestId("replayer");
  expect(board.querySelector('[data-square="f8"] svg.pc')).not.toBeNull();
  expect(screen.getByText("150/300")).not.toBeNull();
  expect(client.getReplay).toHaveBeenCalledTimes(1);

  // -- Keyboard controls: → advances, space toggles auto mode.
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByText("151/300");
  fireEvent.keyDown(window, { key: " " });
  expect(screen.getByRole("button", { name: "pause" })).not.toBeNull();
  fireEvent.keyDown(window, { key: " " });
  expect(screen.getByRole("button", { name: "play" })).not.toBeNull();

  // -- PGN download is byte-exact from the payload's `pgn` field.
  const captured: Blob[] = [];
  const objectUrl = vi.fn((blob: Blob) => {
    captured.push(blob);
    return "blob:test";
  });
  Object.defineProperty(URL, "createObjectURL", {
    value: objectUrl,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
  });
  fireEvent.click(screen.getByRole("button", { name: /download PGN/ }));
  expect(captured).toHaveLength(1);
  const first = captured[0] as Blob;
  expect(await first.text()).toBe(replay.pgn);
  view.unmount();

  // -- Unknown or non-terminal ids render NotFound with no retry loop.
  const missing = publicOnlyClient(async () => {
    throw new ApiError(
      404,
      { error: "GAME_NOT_FOUND", hint: "game not found", docs: "" },
      null,
      new Headers(),
    );
  });
  renderReplay(missing, "/replay/gm_missing");
  await screen.findByText("[ NO SIGNAL ]");
  await waitFor(() => {
    expect(missing.getReplay).toHaveBeenCalledTimes(1);
  });

  // -- Transport failures retain their hint and offer an explicit retry;
  //    they are not misrepresented as an unknown game.
  cleanup();
  clearReplayCacheForTests();
  const recoveredReplay = replayFixture("gm_retry");
  const flaky = publicOnlyClient(
    vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(recoveredReplay),
  );
  renderReplay(flaky, "/replay/gm_retry");
  expect((await screen.findByRole("alert")).textContent).toContain(
    "replay unavailable",
  );
  expect(screen.queryByText("[ NO SIGNAL ]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "retry ▸" }));
  await screen.findByTestId("replay-page");
  expect(flaky.getReplay).toHaveBeenCalledTimes(2);
});
