import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { clearReplayCacheForTests } from "../api/replayCache.js";
import { SessionProvider } from "../auth/SessionContext.jsx";
import { ToastProvider } from "../components/Toasts.jsx";
import { MetaProvider } from "../meta/MetaContext.jsx";
import {
  finishedStakedFixture,
  metaFixture,
  mockClient,
  replayFixture,
} from "../test/fixtures.jsx";
import { Archive } from "./Archive.jsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  clearReplayCacheForTests();
});

function pagedClient() {
  return mockClient({
    getFinishedGames: vi.fn(async (page: number) => ({
      items: [
        finishedStakedFixture({
          gameId: `gm_page${page}`,
          gameName: `page-${page}-game`,
          // A distinctive final position: white queen on a8.
          finalFen: "Q7/8/8/8/8/8/8/4K2k b - - 0 61",
        }),
      ],
      page,
      pageCount: 3,
      total: 21,
    })),
    getReplay: vi.fn(async (gameId: string) => replayFixture(gameId)),
  } as never);
}

function renderArchive(
  client: ReturnType<typeof pagedClient>,
  initialEntry = "/archive",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <MetaProvider client={client}>
          <SessionProvider client={client}>
            <Archive client={client} meta={metaFixture} />
          </SessionProvider>
        </MetaProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

it("archive_uses_final_fen_without_replay_until_quick_view", async () => {
  const client = pagedClient();
  const view = renderArchive(client);

  // -- Grid thumbnails render from finalFen with zero replay requests.
  const card = await screen.findByTestId("finished-card");
  const queenSquare = card.querySelector('[data-square="a8"] svg.pc');
  expect(queenSquare).not.toBeNull();
  expect(client.getReplay).not.toHaveBeenCalled();

  // -- Pagination boundaries: page 1 disables prev; next requests page 2.
  const prev = screen.getByRole("button", { name: "◂ prev" });
  expect((prev as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "next ▸" }));
  await waitFor(() => {
    expect(client.getFinishedGames).toHaveBeenCalledWith(2);
  });
  expect(client.getReplay).not.toHaveBeenCalled();
  view.unmount();

  // -- The last page disables next.
  const client3 = pagedClient();
  renderArchive(client3, "/archive?page=3");
  await waitFor(() => {
    expect(client3.getFinishedGames).toHaveBeenCalledWith(3);
  });
  await screen.findByText("page 3/3");
  const next = screen.getByRole("button", { name: "next ▸" });
  expect((next as HTMLButtonElement).disabled).toBe(true);

  // -- The quick-view fetches its replay on open, once — reopening serves
  //    the cache.
  fireEvent.click(screen.getByTestId("finished-card"));
  await screen.findByTestId("quick-view");
  await screen.findByTestId("replayer");
  expect(client3.getReplay).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "close" }));
  fireEvent.click(screen.getByTestId("finished-card"));
  await screen.findByTestId("quick-view");
  await screen.findByTestId("replayer");
  expect(client3.getReplay).toHaveBeenCalledTimes(1);
});
