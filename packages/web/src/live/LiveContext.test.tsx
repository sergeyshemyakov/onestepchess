import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type AuthHandlers } from "../App.jsx";
import type { EventSourceLike } from "../api/sse.js";
import { writeClaimDraft } from "../lib/storage.js";
import {
  claimFixture,
  emptyGamesPage,
  finishedStakedFixture,
  mockClient,
  profileFixture,
  replayFixture,
} from "../test/fixtures.jsx";

class FakeEventSource implements EventSourceLike {
  static current: FakeEventSource | null = null;
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    const event =
      data === undefined
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const handlers: AuthHandlers = { onUnauthorized: () => undefined };
const factory = (url: string) => new FakeEventSource(url);

afterEach(() => {
  cleanup();
  FakeEventSource.current = null;
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

function source(): FakeEventSource {
  const current = FakeEventSource.current;
  if (current === null) throw new Error("SSE did not connect");
  return current;
}

describe("Release 2 live human surfaces", () => {
  it("sse_fanout_maps_every_event_to_its_human_surface", async () => {
    const claim = claimFixture();
    const secondClaim = claimFixture({ claimId: "clm_test2" });
    let resolved = false;
    let claimActive = false;
    let claimCount = 0;
    const receipt = {
      status: "moved" as const,
      move: claim.legalMoves[0] as { uci: string; san: string },
      debitMicroUsdc: 10_000,
      txid: "MOCK_ACCEPTED_TX",
      explorerUrl: "https://explorer.example/tx/MOCK_ACCEPTED_TX",
      fenAfterYourMove:
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    };
    const client = mockClient({
      createClaim: vi.fn(async () => {
        claimCount += 1;
        return {
          kind: "claim" as const,
          claim: claimCount === 1 ? claim : secondClaim,
          created: true,
        };
      }),
      getCurrentClaim: vi.fn(async () => (claimActive ? secondClaim : null)),
      getClaimStatus: vi.fn(async () => ({ status: "moved", receipt })),
      getProfile: vi.fn(async () => profileFixture({ refCode: "live-rook" })),
      getFinishedGames: vi.fn(async () =>
        resolved
          ? {
              items: [finishedStakedFixture({ gameId: "gm_live_win" })],
              page: 1,
              pageCount: 1,
              total: 1,
            }
          : emptyGamesPage,
      ),
    } as never);

    render(
      <App
        client={client}
        authHandlers={handlers}
        eventSourceFactory={factory}
      />,
    );
    const play = await screen.findByRole("button", { name: /▸ PLAY/ });
    await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
    expect(source().url).toBe("/api/v1/events");

    source().emit("game_available", {});
    await waitFor(() => expect(play.className).toContain("live-pulse"));

    fireEvent.click(play);
    await screen.findByText(/YOU PLAY WHITE/);
    source().emit("claim_expiring", {
      claimId: claim.claimId,
      deadline: new Date(Date.now() + 90_000).toISOString(),
    });
    await waitFor(() =>
      expect(screen.getByText(/T-01:/).textContent).toMatch(/T-01:/),
    );
    source().emit("move_accepted", {
      claimId: claim.claimId,
      txid: "MOCK_ACCEPTED_TX",
    });
    await waitFor(() => expect(client.getClaimStatus).toHaveBeenCalled());
    await screen.findByTestId("move-accepted-line");
    expect(screen.getByTestId("receipt").textContent).toContain(
      "MOCK_ACCEPTED_TX",
    );
    fireEvent.click(screen.getByRole("button", { name: "close" }));

    claimActive = true;
    fireEvent.click(screen.getByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText(/YOU PLAY WHITE/);
    await waitFor(() =>
      expect(sessionStorage.getItem("osc.claimDraft")).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("link", { name: "ARCHIVE" }));
    await screen.findByRole("heading", { name: "ACTIVE" });
    expect(await screen.findByText(/board reserved/)).not.toBeNull();
    claimActive = false;
    source().emit("claim_expired", { claimId: secondClaim.claimId });
    await waitFor(() =>
      expect(screen.queryByText(/board reserved/)).toBeNull(),
    );
    source().emit("game_available", {});
    await screen.findByText(/a board is ready/);

    source().emit("system_banner", {
      mode: "paused",
      banner: "live maintenance",
    });
    expect(await screen.findByText(/live maintenance/)).not.toBeNull();

    resolved = true;
    source().emit("game_resolved", {
      gameId: "gm_live_win",
      gameName: "live-rook-001",
      result: "white",
      termination: "checkmate",
      yourEntries: [
        {
          demo: false,
          side: "white",
          stakeMicroUsdc: 10_000,
          payoutMicroUsdc: 20_000,
          ply: 7,
        },
      ],
      totalPayoutMicroUsdc: 20_000,
    });
    fireEvent.click(await screen.findByRole("button", { name: "share ▸" }));
    expect(await screen.findByTestId("share-sheet")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "close" }));

    source().emit("payout_confirmed", {
      gameId: "gm_live_win",
      txid: "PAYOUT_LIVE_TX",
      amountMicroUsdc: 20_000,
    });
    expect(
      (await screen.findByRole("link", { name: "confirmed ↗" })).getAttribute(
        "href",
      ),
    ).toBe("https://explorer.example/tx/PAYOUT_LIVE_TX");

    source().emit("bonus_updated", { status: "funded" });
    source().emit("config_updated", { revision: 2 });
    source().emit("game_resolved", {
      result: "black",
      termination: "checkmate",
      yourEntries: [
        {
          demo: true,
          side: "white",
          stakeMicroUsdc: 0,
          payoutMicroUsdc: 0,
        },
      ],
      totalPayoutMicroUsdc: 0,
    });
    await screen.findByText(/nothing staked, nothing counted/);
    expect(
      document.querySelectorAll("#toasts .toast").length,
    ).toBeLessThanOrEqual(3);
    expect(client.getProfile).toHaveBeenCalled();
    expect(client.getOngoingGames).toHaveBeenCalled();
    expect(client.getFinishedGames).toHaveBeenCalled();
    expect(client.getMeta).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "BOARDS" }));
    const finishedTab = await screen.findByRole("tab", { name: "FINISHED" });
    expect(finishedTab.textContent).toContain("· NEW");
  });

  it("sse_reconnect_and_reset_rehydrate_all_rest_state", async () => {
    window.history.pushState({}, "", "/archive");
    const client = mockClient({
      getCurrentClaim: vi.fn(async () => claimFixture()),
      getProfile: vi.fn(async () => profileFixture()),
      getOngoingGames: vi.fn(async () => emptyGamesPage),
      getFinishedGames: vi.fn(async () => ({
        items: [finishedStakedFixture()],
        page: 1,
        pageCount: 1,
        total: 1,
      })),
    } as never);
    render(
      <App
        client={client}
        authHandlers={handlers}
        eventSourceFactory={factory}
      />,
    );
    await screen.findByText(/board reserved/);
    await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
    const before = {
      meta: vi.mocked(client.getMeta).mock.calls.length,
      claim: vi.mocked(client.getCurrentClaim).mock.calls.length,
      profile: vi.mocked(client.getProfile).mock.calls.length,
      ongoing: vi.mocked(client.getOngoingGames).mock.calls.length,
      finished: vi.mocked(client.getFinishedGames).mock.calls.length,
    };

    source().emit("error");
    expect(await screen.findByText("reconnecting…")).not.toBeNull();
    source().emit("open");
    await waitFor(() => expect(screen.queryByText("reconnecting…")).toBeNull());
    expect(vi.mocked(client.getMeta).mock.calls.length).toBeGreaterThan(
      before.meta,
    );

    source().emit("stream_reset", { reason: "cursor_expired" });
    await waitFor(() => {
      expect(
        vi.mocked(client.getCurrentClaim).mock.calls.length,
      ).toBeGreaterThan(before.claim);
      expect(vi.mocked(client.getProfile).mock.calls.length).toBeGreaterThan(
        before.profile,
      );
      expect(
        vi.mocked(client.getOngoingGames).mock.calls.length,
      ).toBeGreaterThan(before.ongoing);
      expect(
        vi.mocked(client.getFinishedGames).mock.calls.length,
      ).toBeGreaterThan(before.finished);
    });
  });

  it("claim_bar_follows_open_claim_across_every_route", async () => {
    for (const path of [
      "/archive",
      "/start",
      "/championship",
      "/definitely-missing",
    ]) {
      window.history.pushState({}, "", path);
      const client = mockClient({
        getCurrentClaim: vi.fn(async () => claimFixture()),
      } as never);
      const view = render(<App client={client} authHandlers={handlers} />);
      expect(await screen.findByText(/board reserved/)).not.toBeNull();
      view.unmount();
    }

    writeClaimDraft({
      claimId: "clm_public_replay",
      deadline: new Date(Date.now() + 120_000).toISOString(),
      savedAt: new Date().toISOString(),
    });
    window.history.pushState({}, "", "/replay/gm_public");
    const replayClient = mockClient({
      getReplay: vi.fn(async () => replayFixture("gm_public")),
    } as never);
    render(<App client={replayClient} authHandlers={handlers} />);
    expect(await screen.findByText(/board reserved/)).not.toBeNull();
    expect(replayClient.probeProfile).not.toHaveBeenCalled();
    expect(replayClient.getCurrentClaim).not.toHaveBeenCalled();
  });
});
