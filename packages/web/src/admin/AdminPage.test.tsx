import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type {
  AdminActivity,
  AdminBonuses,
  AdminConfig,
  AdminGameDossier,
  AdminOverview,
  AdminPlayer,
  AdminPlayers,
} from "../api/schemas.js";
import { NotFound } from "../routes/NotFound.jsx";
import { metaFixture, mockClient, Providers } from "../test/fixtures.jsx";
import { AdminRoute } from "./AdminPage.jsx";
import type { AdminClient } from "./client.js";
import { ADMIN_POLL_MS, useAdminOverview } from "./useAdminOverview.js";

const overviewFixture: AdminOverview = {
  mode: "running",
  pauseCauses: [],
  banner: null,
  pool: { target: 8, active: 6, endspiel: 2, claimsOpen: 3 },
  treasury: {
    usdcMicroUsdc: 1_250_000,
    algoMicroAlgo: 2_000_000,
    capMicroUsdc: 5_000_000,
    belowRefundCoverage: false,
  },
  bonusAccount: {
    usdcMicroUsdc: 800_000,
    algoMicroAlgo: 1_500_000,
    minAlgoMicro: 1_000_000,
  },
  payouts: { pending: 1, prepared: 2, submitted: 3, failed: 0 },
  funding: { pending: 0, prepared: 0, submitted: 0, failed: 0 },
  reconciliation: {
    lastRunAt: "2026-07-26T10:00:00Z",
    bookMicroUsdc: 1_250_000,
    chainMicroUsdc: 1_250_000,
    driftMicroUsdc: 0,
    inboundToleranceMicroUsdc: 10_000,
    outboundToleranceMicroUsdc: 10_000,
    ok: true,
  },
  facilitator: {
    healthy: true,
    lastCheckAt: "2026-07-26T10:00:00Z",
  },
  live: {
    uptimeSeconds: 3_600,
    sseClients: 4,
    settleP50Ms: 80,
    settleP95Ms: 140,
  },
};

const activityFixture: AdminActivity = {
  window: "24h",
  fromAt: "2026-07-25T10:00:00Z",
  toAt: "2026-07-26T10:00:00Z",
  counts: {
    activeHumans: 12,
    activeAgents: 5,
    demoOnlyPlayers: 3,
    registrations: 4,
    humanMoves: 20,
    agentMoves: 11,
    demoMoves: 6,
    claimsCreated: 40,
    claimsMoved: 31,
    claimsExpired: 9,
    gamesFinished: 2,
  },
  money: {
    stakeVolumeMicroUsdc: 30_000,
    payoutVolumeMicroUsdc: 20_000,
    protocolTakeMicroUsdc: 1_000,
    treasuryNetFlowMicroUsdc: -5_000,
  },
  tripwires: {
    claimMovePctHuman: 80,
    claimMovePctAgent: 75,
    demoSharePct: 15,
    demoToStakedPct: 25,
    humanMoveLatencyP50Seconds: 12,
    humanMoveLatencyP95Seconds: 42,
    quotaSaturationPct: null,
    topWinners: [{ address: "alice", nickname: "alice", pnlMicroUsdc: 20_000 }],
    topLosers: [{ address: "bob", nickname: "bob", pnlMicroUsdc: -10_000 }],
  },
};

const bonusesFixture: AdminBonuses = {
  todayClaimed: 0,
  dailyCap: 20,
  totalClaimed: 0,
  totalAlgoMicro: 0,
  totalUsdcMicro: 0,
  items: [],
  page: 1,
  pageCount: 0,
  total: 0,
};

const gameDossierFixture: AdminGameDossier = {
  game: {
    id: "gm_ops",
    name: "gentle-rook-042",
    status: "active",
    ply: 4,
    result: null,
    stakePotMicroUsdc: 20_000,
    claimsOpen: 0,
    createdAt: "2026-07-26T09:00:00Z",
    finishedAt: null,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    pgn: '[Event "One Step Chess"]',
    termination: null,
    endspielPly: null,
    rules: { maxPlies: 240 },
  },
  claims: [
    {
      id: "clm_ops",
      player: "alice",
      nickname: "alice",
      side: "white",
      demo: false,
      status: "moved",
      stakeMicroUsdc: 10_000,
      move: { uci: "e2e4", san: "e4" },
      claimedAt: "2026-07-26T09:00:00Z",
      deadline: "2026-07-26T09:10:00Z",
      movedAt: "2026-07-26T09:00:12Z",
    },
  ],
  stakes: [
    {
      id: "stk_ops",
      player: "alice",
      side: "white",
      kind: "human",
      amountMicroUsdc: 10_000,
      payTxid: "PAYTX",
      ply: 1,
    },
  ],
  resolution: null,
  payoutJobs: [],
};

const playerFixture: AdminPlayer = {
  address: "alice",
  nickname: "alice",
  kind: "human",
  banned: false,
  quotaOverride: null,
  abandonCount: 0,
  deprioritizedUntil: null,
  stats: {
    moves: 10,
    wins: 5,
    draws: 1,
    losses: 4,
    winratePct: 55.55555555555556,
  },
  netPnlMicroUsdc: 20_000,
  points: 120,
  referredBy: null,
  referrals: { joined: 2, qualified: 1 },
  quota: {
    staked: { limit: 10, remaining: 8, resetsAt: null },
    demo: { limit: 10, remaining: 10, resetsAt: null },
  },
  recentClaims: gameDossierFixture.claims,
};

const playersFixture: AdminPlayers = {
  items: [
    {
      address: "ALICE-ALGORAND-ADDRESS",
      nickname: "alice",
      kind: "human",
      createdAt: "2026-07-20T10:00:00Z",
      lastActiveAt: "2026-07-26T10:00:00Z",
      banned: false,
      deprioritizedUntil: null,
      abandonCount: 2,
      points: 120,
      stats: {
        moves: 10,
        wins: 5,
        draws: 1,
        losses: 4,
        winratePct: 55.55555555555556,
      },
      netPnlMicroUsdc: 20_000,
    },
  ],
  page: 1,
  pageCount: 1,
  total: 1,
};

const configFixture: AdminConfig = {
  revision: 7,
  items: [
    {
      key: "QUOTA_AGENT",
      defaultValue: 60,
      overrideValue: 77,
      effectiveValue: 77,
      description: "Agent claims allowed per rolling hour.",
      effect: "new_claims",
      editable: true,
      updatedAt: "2026-07-26T10:00:00Z",
      updatedBy: "admin-wallet",
    },
    {
      key: "GAME_POOL_TARGET",
      defaultValue: 8,
      overrideValue: null,
      effectiveValue: 8,
      description: "Number of live games the pool keeps available.",
      effect: "new_games",
      editable: true,
      updatedAt: null,
      updatedBy: null,
    },
    {
      key: "HUMAN_BOARD_RESERVE_PERCENT",
      defaultValue: 25,
      overrideValue: null,
      effectiveValue: 25,
      description:
        "Minimum percentage of live boards kept free for human claims.",
      effect: "new_claims",
      editable: true,
      updatedAt: null,
      updatedBy: null,
    },
  ],
  history: [
    {
      id: 1,
      at: "2026-07-26T10:00:00Z",
      actor: "admin-wallet",
      action: "config.set",
      payload: { key: "QUOTA_AGENT", value: 77 },
    },
  ],
};

function adminClient(overrides: Partial<AdminClient> = {}): AdminClient {
  return {
    getAdminOverview: vi.fn(async () => ({
      kind: "data" as const,
      overview: overviewFixture,
      etag: '"overview-1"',
    })),
    getAdminActivity: vi.fn(async (window) => ({
      ...activityFixture,
      window,
    })),
    getAdminBonuses: vi.fn(async () => bonusesFixture),
    retryAdminBonus: vi.fn(async () => ({
      status: "pending" as const,
      jobs: 1,
    })),
    getAdminErrors: vi.fn(async () => ({
      items: [
        {
          id: 1,
          at: "2026-07-26T10:00:00Z",
          level: "error",
          code: "PAYOUT_FAILED",
          requestId: "req_ops",
          context: { gameId: "gm_ops", secret: "[REDACTED]" },
        },
      ],
      page: 1,
      pageCount: 1,
      total: 1,
    })),
    getAdminGames: vi.fn(async () => ({
      items: [gameDossierFixture.game],
      page: 1,
      pageCount: 1,
      total: 1,
    })),
    getAdminGame: vi.fn(async () => gameDossierFixture),
    getAdminPlayer: vi.fn(async () => playerFixture),
    getAdminPlayers: vi.fn(async () => playersFixture),
    getAdminConfig: vi.fn(async () => configFixture),
    pauseAdmin: vi.fn(async () => undefined),
    resumeAdmin: vi.fn(async () => undefined),
    setAdminConfig: vi.fn(async () => undefined),
    revertAdminConfig: vi.fn(async () => undefined),
    ...overrides,
  };
}

function envelopeError(status: number, hint: string) {
  return new ApiError(
    status,
    { error: status === 404 ? "NOT_FOUND" : "INVALID_REQUEST", hint, docs: "" },
    null,
    new Headers(),
  );
}

function renderAdmin(client: AdminClient, webClient = mockClient()) {
  return render(
    <Providers client={webClient}>
      <AdminRoute client={client} />
    </Providers>,
  );
}

async function notFoundMarkup(children: ReactNode, client = mockClient()) {
  const view = render(<Providers client={client}>{children}</Providers>);
  await screen.findByText("[ NO SIGNAL ]");
  const markup = view.container.querySelector(".crt")?.outerHTML;
  view.unmount();
  cleanup();
  return markup;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("admin route and polling (#73)", () => {
  it("admin_route_is_pixel_identical_notfound_for_logged_out_and_nonallowlisted_users", async () => {
    const genuineUnknown = await notFoundMarkup(
      <Routes>
        <Route path="*" element={<NotFound />} />
      </Routes>,
    );
    const loggedOut = await notFoundMarkup(
      <AdminRoute client={adminClient()} />,
      mockClient({ probeProfile: vi.fn(async () => null) } as never),
    );
    const denied = adminClient({
      getAdminOverview: vi.fn(async () => {
        throw envelopeError(404, "not found");
      }),
    });
    const unauthorized = await notFoundMarkup(<AdminRoute client={denied} />);
    const banned = await notFoundMarkup(
      <AdminRoute
        client={adminClient({
          getAdminOverview: vi.fn(async () => {
            throw envelopeError(404, "not found");
          }),
        })}
      />,
    );

    expect(loggedOut).toBe(genuineUnknown);
    expect(unauthorized).toBe(genuineUnknown);
    expect(banned).toBe(genuineUnknown);

    renderAdmin(adminClient());
    expect(await screen.findByText("OPERATIONS CONSOLE")).not.toBeNull();
    expect(screen.queryByText("[ NO SIGNAL ]")).toBeNull();
  });

  it("admin_overview_polls_visible_tabs_with_etag_and_stops_hidden", async () => {
    vi.useFakeTimers();
    let hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    const getAdminOverview = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "data",
        overview: overviewFixture,
        etag: '"overview-1"',
      })
      .mockResolvedValue({
        kind: "not_modified",
        etag: '"overview-1"',
      });
    const client = adminClient({ getAdminOverview });

    function Probe() {
      const state = useAdminOverview(client);
      return <span>{state.overview?.pool.active ?? "waiting"}</span>;
    }

    const view = render(<Probe />);
    await act(async () => Promise.resolve());
    expect(screen.getByText("6")).not.toBeNull();
    expect(getAdminOverview).toHaveBeenNthCalledWith(1, undefined);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ADMIN_POLL_MS);
    });
    expect(getAdminOverview).toHaveBeenNthCalledWith(2, '"overview-1"');
    expect(screen.getByText("6")).not.toBeNull();

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ADMIN_POLL_MS * 2);
    });
    expect(getAdminOverview).toHaveBeenCalledTimes(2);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => Promise.resolve());
    expect(getAdminOverview).toHaveBeenCalledTimes(3);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ADMIN_POLL_MS);
    });
    expect(getAdminOverview).toHaveBeenCalledTimes(3);
  });
});

describe("admin read panels (#73)", () => {
  it("admin_six_panels_render_pinned_read_models_and_drilldowns", async () => {
    const client = adminClient();
    renderAdmin(client);

    expect(await screen.findByText("active humans")).not.toBeNull();
    expect(screen.getByText("12")).not.toBeNull();
    expect(screen.getByText("-0.5 ¢")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() =>
      expect(client.getAdminActivity).toHaveBeenLastCalledWith("7d"),
    );

    fireEvent.click(screen.getByRole("tab", { name: "BONUSES" }));
    expect(
      await screen.findByRole("heading", { name: "BONUSES" }),
    ).not.toBeNull();
    expect(screen.getByText("today / daily cap")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "HEALTH" }));
    expect(await screen.findByText("PAYOUT_FAILED")).not.toBeNull();
    fireEvent.click(screen.getByText("PAYOUT_FAILED"));
    expect(screen.getByText(/REDACTED/)).not.toBeNull();
    expect(screen.getAllByText(/\$1\.25/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "GAMES" }));
    const game = await screen.findByRole("button", { name: "Game ops" });
    fireEvent.change(screen.getByLabelText("game id or name"), {
      target: { value: "gm_ops" },
    });
    fireEvent.click(screen.getByRole("button", { name: "search" }));
    await waitFor(() =>
      expect(client.getAdminGames).toHaveBeenLastCalledWith({
        page: 1,
        q: "gm_ops",
      }),
    );
    fireEvent.click(game);
    expect(await screen.findByLabelText("game dossier")).not.toBeNull();
    expect(screen.getByText("CLAIM TIMELINE")).not.toBeNull();
    const playerLink = screen
      .getByLabelText("game dossier")
      .querySelector<HTMLButtonElement>(".admin-link");
    if (playerLink === null) throw new Error("player link missing");
    fireEvent.click(playerLink);
    expect(await screen.findByLabelText("player dossier")).not.toBeNull();
    expect(screen.getByText("net PnL")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "PLAYERS" }));
    expect(
      await screen.findByRole("heading", { name: "PLAYERS" }),
    ).not.toBeNull();
    expect(screen.getByText("ALICE-ALGORAND-ADDRESS")).not.toBeNull();
    expect(screen.getByText("55.6%")).not.toBeNull();
    expect(screen.getByText("120 points")).not.toBeNull();
    expect(screen.getByText("10 moves · 2 abandons")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("player address or nickname"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText("player kind"), {
      target: { value: "human" },
    });
    const playersPanel = document.getElementById("admin-panel-players");
    const playerSearch = playersPanel?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (playerSearch === undefined || playerSearch === null) {
      throw new Error("player search button missing");
    }
    fireEvent.click(playerSearch);
    await waitFor(() =>
      expect(client.getAdminPlayers).toHaveBeenLastCalledWith({
        page: 1,
        q: "alice",
        kind: "human",
      }),
    );
    const playerButton = playersPanel?.querySelector<HTMLButtonElement>(
      ".admin-players-table .admin-link",
    );
    if (playerButton === undefined || playerButton === null) {
      throw new Error("player row link missing");
    }
    fireEvent.click(playerButton);
    expect(await screen.findByLabelText("player dossier")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "CONFIG" }));
    expect(await screen.findByText("QUOTA_AGENT")).not.toBeNull();
    expect(screen.getByText("revision").parentElement?.textContent).toContain(
      "7",
    );
    expect(screen.getByText("change history (1)")).not.toBeNull();
  });

  it("bonuses_panel_renders_live_funding_status_and_manual_review_fields_without_secret_data", async () => {
    const liveBonuses: AdminBonuses = {
      ...bonusesFixture,
      todayClaimed: 1,
      totalClaimed: 1,
      totalAlgoMicro: 250_000,
      totalUsdcMicro: 200_000,
      pageCount: 1,
      total: 1,
      items: [
        {
          address: "ALICE-ALGORAND-ADDRESS",
          nickname: "alice",
          status: "claimed",
          claimIp: "203.0.113.7",
          claimedAt: "2026-07-31T10:00:00Z",
          fundedAt: null,
          algoTxid: "ALGO-TXID",
          usdcTxid: null,
          lifetimeStakedMoves: 3,
          points: 120,
          referredBy: "referrer-address",
        },
      ],
    };
    const retryAdminBonus = vi.fn(async () => ({
      status: "pending" as const,
      jobs: 1,
    }));
    const client = adminClient({
      getAdminBonuses: vi.fn(async () => liveBonuses),
      retryAdminBonus,
    });
    renderAdmin(client);
    fireEvent.click(await screen.findByRole("tab", { name: "BONUSES" }));
    expect(await screen.findByText("203.0.113.7")).not.toBeNull();
    expect(screen.getByText("3 / 120")).not.toBeNull();
    expect(screen.getByText("referred by referrer-address")).not.toBeNull();
    expect(
      document.querySelector<HTMLAnchorElement>('a[href*="ALGO-TXID"]')?.href,
    ).toBe("https://explorer.example/tx/ALGO-TXID");
    expect(document.body.textContent).not.toContain("signedTxnB64");
    expect(document.body.textContent).not.toContain("mnemonic");

    fireEvent.click(screen.getByRole("button", { name: "retry funding" }));
    expect(await screen.findByText("1 funding leg re-armed")).not.toBeNull();
    expect(retryAdminBonus).toHaveBeenCalledWith("ALICE-ALGORAND-ADDRESS");
  });
});

describe("admin mutations (#73)", () => {
  it("admin_pause_requires_two_interactions_and_reflects_system_banner", async () => {
    let mode: AdminOverview["mode"] = "running";
    let banner: string | null = null;
    const getAdminOverview = vi.fn(async () => ({
      kind: "data" as const,
      overview: { ...overviewFixture, mode, banner },
      etag: `"${mode}"`,
    }));
    const pauseAdmin = vi.fn(async (nextBanner?: string) => {
      mode = "paused";
      banner = nextBanner ?? "maintenance";
    });
    const resumeAdmin = vi.fn(async () => {
      mode = "running";
      banner = null;
    });
    const webClient = mockClient({
      getMeta: vi.fn(async () => ({
        ...metaFixture,
        status: { mode, banner },
      })),
    } as never);
    const client = adminClient({
      getAdminOverview,
      pauseAdmin,
      resumeAdmin,
    });
    renderAdmin(client, webClient);

    fireEvent.click(await screen.findByRole("button", { name: "PAUSE" }));
    expect(pauseAdmin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(pauseAdmin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "PAUSE" }));
    fireEvent.change(screen.getByLabelText("optional system banner"), {
      target: { value: "incident maintenance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirm pause" }));
    await waitFor(() =>
      expect(pauseAdmin).toHaveBeenCalledWith("incident maintenance"),
    );
    expect(
      await screen.findByRole("button", { name: "RESUME" }),
    ).not.toBeNull();
    expect(document.querySelector(".banner")?.textContent).toContain(
      "incident maintenance",
    );

    fireEvent.click(screen.getByRole("button", { name: "RESUME" }));
    expect(resumeAdmin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "confirm resume" }));
    await waitFor(() => expect(resumeAdmin).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "PAUSE" })).not.toBeNull();

    pauseAdmin.mockRejectedValueOnce(
      envelopeError(400, "manual pause rejected by coordinator"),
    );
    fireEvent.click(screen.getByRole("button", { name: "PAUSE" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm pause" }));
    expect(
      await screen.findByText("manual pause rejected by coordinator"),
    ).not.toBeNull();
    expect(webClient.getMeta).toHaveBeenCalled();
    expect(getAdminOverview.mock.calls.length).toBeGreaterThan(1);
  });

  it("admin_config_edit_and_revert_render_server_validation_verbatim", async () => {
    let config = configFixture;
    const getAdminConfig = vi.fn(async () => config);
    const setAdminConfig = vi
      .fn()
      .mockRejectedValueOnce(
        envelopeError(400, "QUOTA_AGENT must be an integer between 1 and 120"),
      )
      .mockImplementationOnce(async (_key: string, value: unknown) => {
        config = {
          ...config,
          revision: 8,
          items: config.items.map((item) =>
            item.key === "QUOTA_AGENT"
              ? {
                  ...item,
                  overrideValue: value,
                  effectiveValue: value,
                }
              : item,
          ),
        };
      });
    const revertAdminConfig = vi.fn(async () => {
      config = {
        ...config,
        revision: 9,
        items: config.items.map((item) =>
          item.key === "QUOTA_AGENT"
            ? {
                ...item,
                overrideValue: null,
                effectiveValue: item.defaultValue,
              }
            : item,
        ),
      };
    });
    const client = adminClient({
      getAdminConfig,
      setAdminConfig,
      revertAdminConfig,
    });
    renderAdmin(client);
    fireEvent.click(await screen.findByRole("tab", { name: "CONFIG" }));

    const input = await screen.findByLabelText("QUOTA_AGENT value");
    expect(screen.getByText("OVERRIDDEN")).not.toBeNull();
    expect(screen.getByText("next quota window / new claims")).not.toBeNull();
    expect(screen.getByText("new games")).not.toBeNull();
    expect(
      screen.getByText("Agent claims allowed per rolling hour."),
    ).not.toBeNull();
    expect(
      screen.getByText("Number of live games the pool keeps available."),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Minimum percentage of live boards kept free for human claims.",
      ),
    ).not.toBeNull();
    expect(screen.getByText("change history (1)")).not.toBeNull();

    fireEvent.change(input, { target: { value: "121" } });
    const save = screen.getAllByRole("button", { name: "save" })[0];
    if (save === undefined) throw new Error("save button missing");
    fireEvent.click(save);
    expect(
      await screen.findByText(
        "QUOTA_AGENT must be an integer between 1 and 120",
      ),
    ).not.toBeNull();

    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.click(save);
    await waitFor(() => expect(setAdminConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("QUOTA_AGENT value") as HTMLInputElement).value,
      ).toBe("80");
    });
    const revert = screen
      .getAllByRole("button", { name: "revert" })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (revert === undefined) throw new Error("enabled revert button missing");
    fireEvent.click(revert);
    await waitFor(() => expect(revertAdminConfig).toHaveBeenCalledTimes(1));
    expect(
      (await screen.findByText("revision")).parentElement?.textContent,
    ).toContain("9");
  });
});

describe("admin responsive accessibility (#73)", () => {
  it("admin_incident_flow_works_at_420_and_768", async () => {
    renderAdmin(adminClient());
    const activity = await screen.findByRole("tab", { name: "ACTIVITY" });
    const bonuses = screen.getByRole("tab", { name: "BONUSES" });
    activity.focus();
    fireEvent.keyDown(activity, { key: "ArrowRight" });
    expect(document.activeElement).toBe(bonuses);
    expect(bonuses.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("heading", { name: "BONUSES" }),
    ).not.toBeNull();

    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../styles/components.css"),
      "utf8",
    );
    expect(css).toMatch(/@media \(max-width: 768px\)/);
    expect(css).toMatch(/@media \(max-width: 420px\)/);
    expect(css).toMatch(/\.admin-tabs \.btn \{[\s\S]*?min-height: 44px/);
    expect(css).toMatch(/\.admin-panel-slot\.active \{[\s\S]*?display: block/);
    expect(css).toMatch(/\.admin-stack \{[\s\S]*?display: grid/);
    expect(css).toMatch(/\.admin-link:focus-visible/);
    expect(document.querySelector("[title]")).toBeNull();
  });
});
