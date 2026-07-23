import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MoveReceipt } from "../api/schemas.js";
import { resetTurnstileForTests } from "../auth/turnstile.js";
import { writeClaimDraft } from "../lib/storage.js";
import {
  claimFixture,
  metaFixture,
  mockClient,
  Providers,
} from "../test/fixtures.jsx";
import { assertNoGameIdentity } from "../test/leak.js";
import { Landing } from "./Landing.jsx";

const moduleSpies = vi.hoisted(() => ({
  createWalletModule: vi.fn(),
  payMove: vi.fn(),
}));

vi.mock("../wallet/provider.js", () => ({
  createWalletModule: moduleSpies.createWalletModule,
}));

vi.mock("../wallet/x402.js", () => ({
  payMove: moduleSpies.payMove,
}));

const identitySeeds = ["gm_guest_secret", "hidden-game-name", "ply 42"];

const receipt: MoveReceipt = {
  status: "moved",
  move: { uci: "e2e4", san: "e4" },
  debitMicroUsdc: 0,
  txid: null,
  explorerUrl: null,
  fenAfterYourMove:
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  resetTurnstileForTests();
  window.turnstile = undefined;
  moduleSpies.createWalletModule.mockReset();
  moduleSpies.payMove.mockReset();
});

function guestClient(moveResult: unknown = { kind: "receipt", receipt }) {
  return mockClient({
    probeProfile: vi.fn(async () => null),
    getCurrentClaim: vi.fn(async () => null),
    createClaim: vi.fn(async () => ({
      kind: "claim" as const,
      claim: {
        ...claimFixture({ demo: true, stakeMicroUsdc: 0 }),
        gameId: "gm_guest_secret",
        gameName: "hidden-game-name",
        yourPly: "ply 42",
      },
      created: true,
    })),
    postMove: vi.fn(async () => moveResult as never),
  });
}

function renderLanding(
  client: ReturnType<typeof guestClient>,
  meta = metaFixture,
) {
  return render(
    <Providers client={client}>
      <Landing client={client} meta={meta} onSignedIn={vi.fn()} />
    </Providers>,
  );
}

async function reachConfirm(_view: ReturnType<typeof render>) {
  fireEvent.click(
    await screen.findByRole("button", { name: /PLAY A DEMO GAME/ }),
  );
  await screen.findByText(/YOU PLAY WHITE/);
  // The landing renders the bundled Deep Blue board too — scope square
  // taps to the play surface.
  const surface = screen.getByTestId("play-surface");
  fireEvent.click(surface.querySelector('[data-square="e2"]') as Element);
  fireEvent.click(surface.querySelector('[data-square="e4"]') as Element);
  await screen.findByText("FINAL MOVE?");
}

it("landing_uses_only_meta_and_session_probe_before_interaction", async () => {
  // -- API count: exactly /meta + the session boot probe, nothing else.
  const client = guestClient();
  const view = renderLanding(client);
  await screen.findByRole("button", { name: /I HAVE AN ALGORAND WALLET/ });
  expect(client.getMeta).toHaveBeenCalledTimes(1);
  expect(client.probeProfile).toHaveBeenCalledTimes(1);
  expect(client.createClaim).not.toHaveBeenCalled();
  expect(client.getReplay).not.toHaveBeenCalled();
  expect(client.getProfile).not.toHaveBeenCalled();
  expect(client.getOngoingGames).not.toHaveBeenCalled();
  expect(client.getFinishedGames).not.toHaveBeenCalled();
  expect(client.getCurrentClaim).not.toHaveBeenCalled();

  // -- Bundled replay: the Deep Blue strip renders a board with no fetch.
  const strip = screen.getByTestId("deepblue-strip");
  expect(strip.querySelector('[data-square="e4"]')).not.toBeNull();
  expect(
    screen.getByText(/deep blue – kasparov · game 6 · 1997/),
  ).not.toBeNull();

  // -- Lazy wallet/Turnstile code: neither loads before interaction.
  expect(moduleSpies.createWalletModule).not.toHaveBeenCalled();
  expect(document.querySelector('script[src*="turnstile"]')).toBeNull();

  // -- CTA/nudge swap follows osc.guestDemo.
  expect(
    screen.getByRole("button", { name: /PLAY A DEMO GAME/ }),
  ).not.toBeNull();
  expect(screen.queryByTestId("guest-demo-nudge")).toBeNull();
  // -- Rules render verbatim from /meta; the agent tab links come from
  //    /meta.docs, not hardcoded URLs.
  expect(screen.getByTestId("rules-verbatim").textContent).toBe(
    metaFixture.rules,
  );
  fireEvent.click(screen.getByRole("tab", { name: "FOR AGENTS" }));
  const agentTab = screen.getByTestId("agent-tab");
  expect(
    agentTab.querySelector(`a[href="${metaFixture.docs.llms}"]`),
  ).not.toBeNull();
  expect(
    agentTab.querySelector(`a[href="${metaFixture.docs.repo}"]`),
  ).not.toBeNull();
  // -- Config-gated content: promo strip present (not dismissed), stats
  //    strip absent without meta.stats.
  expect(screen.getByTestId("champ-promo")).not.toBeNull();
  expect(screen.queryByTestId("stats-strip")).toBeNull();
  view.unmount();

  // -- Nudge variant + gated variants flip on state/config.
  localStorage.setItem("osc.guestDemo", "played");
  localStorage.setItem("osc.champNotice", "dismissed");
  const statsMeta = {
    ...metaFixture,
    stats: {
      humanMoves: 41,
      playersRegistered: 7,
      gamesFinished: 5,
      movesSettled: 44,
    },
  };
  renderLanding(guestClient(), statsMeta);
  await screen.findByTestId("guest-demo-nudge");
  expect(screen.queryByRole("button", { name: /PLAY A DEMO GAME/ })).toBeNull();
  expect(screen.queryByTestId("champ-promo")).toBeNull();
  expect(screen.getByTestId("stats-strip").textContent).toContain(
    "41 human moves · 7 wallets · 5 games settled · 44 payments",
  );
});

it("tower_teaser_can_be_closed_and_stays_hidden_during_its_cooldown", async () => {
  const first = renderLanding(guestClient());
  const teaser = await screen.findByTestId("tower-teaser");
  fireEvent.click(
    within(teaser).getByRole("button", {
      name: "dismiss Tower integration notice",
    }),
  );
  expect(screen.queryByTestId("tower-teaser")).toBeNull();
  first.unmount();

  renderLanding(guestClient());
  await screen.findByRole("button", { name: /I HAVE AN ALGORAND WALLET/ });
  expect(screen.queryByTestId("tower-teaser")).toBeNull();
});

it("guest_claim_rehydrates_only_when_this_tab_has_a_draft", async () => {
  const claim = claimFixture({ demo: true, stakeMicroUsdc: 0 });
  writeClaimDraft({
    claimId: claim.claimId,
    savedAt: new Date().toISOString(),
  });
  const client = guestClient();
  client.getCurrentClaim = vi.fn(async () => claim);
  renderLanding(client);
  await screen.findByText(/YOU PLAY WHITE/);
  expect(client.getCurrentClaim).toHaveBeenCalledWith({ anonymous: true });
});

it("anonymous_demo_never_loads_wallet_or_x402_code", async () => {
  const client = guestClient();
  const view = renderLanding(client);
  await reachConfirm(view);
  fireEvent.click(screen.getByRole("button", { name: /Y — make it so/ }));
  await screen.findByTestId("receipt");

  expect(moduleSpies.createWalletModule).not.toHaveBeenCalled();
  expect(moduleSpies.payMove).not.toHaveBeenCalled();
  expect(client.createClaim).toHaveBeenCalledWith({
    demo: true,
    turnstileToken: "dev-fixture-token",
  });
  expect(client.postMove).toHaveBeenCalledWith("clm_test1", "e2e4");
});

it("guest_demo_receipt_and_expiry_render_only_login_wall_data", async () => {
  window.turnstile = {
    render: () => "pending-widget",
    reset: () => undefined,
  };
  const gateView = renderLanding(guestClient(), {
    ...metaFixture,
    turnstileSiteKey: "production-site-key",
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /PLAY A DEMO GAME/ }),
  );
  await waitFor(() => {
    expect(screen.getByTestId("play-surface").dataset.phase).toBe("GUEST_GATE");
  });
  assertNoGameIdentity(gateView.container, identitySeeds);
  gateView.unmount();
  resetTurnstileForTests();
  window.turnstile = undefined;

  const receiptClient = guestClient();
  const receiptView = renderLanding(receiptClient);
  fireEvent.click(
    await screen.findByRole("button", { name: /PLAY A DEMO GAME/ }),
  );
  await waitFor(() => {
    expect(screen.getByTestId("play-surface").dataset.phase).toBe("FOCUS");
  });
  assertNoGameIdentity(receiptView.container, identitySeeds);
  const surface = screen.getByTestId("play-surface");
  fireEvent.click(surface.querySelector('[data-square="e2"]') as Element);
  fireEvent.click(surface.querySelector('[data-square="e4"]') as Element);
  await screen.findByText("FINAL MOVE?");
  assertNoGameIdentity(receiptView.container, identitySeeds);
  fireEvent.click(screen.getByRole("button", { name: /Y — make it so/ }));
  await screen.findByText(/connect an Algorand wallet to see how it ends/);
  expect(screen.getByTestId("onboarding-doors").children).toHaveLength(2);
  assertNoGameIdentity(receiptView.container, identitySeeds);
  receiptView.unmount();
  localStorage.removeItem("osc.guestDemo");

  const expiredClient = guestClient({ kind: "expired" });
  const expiredView = renderLanding(expiredClient);
  await reachConfirm(expiredView);
  fireEvent.click(screen.getByRole("button", { name: /Y — make it so/ }));
  await screen.findByText("POSITION PASSED ON");
  expect(screen.getByText(/log in to keep playing/)).not.toBeNull();
  assertNoGameIdentity(expiredView.container, identitySeeds);
  await waitFor(() => {
    expect(localStorage.getItem("osc.guestDemo")).toBe("expired");
  });
});

it("splits the landing into functional + decorative panes with a tower banner strip", async () => {
  renderLanding(guestClient());
  await screen.findByRole("button", { name: /I HAVE AN ALGORAND WALLET/ });
  expect(screen.queryByText(/strangers and machines share/)).toBeNull();
  const split = screen.getByTestId("landing-split");
  expect(within(split).getByTestId("how-it-works")).not.toBeNull();
  expect(within(split).getByTestId("deepblue-strip")).not.toBeNull();
  expect(
    within(split).getByRole("heading", { name: /ONLY ONE MOVE/ }),
  ).not.toBeNull();
  const tower = screen.getByTestId("tower-teaser");
  expect(tower.className).toContain("promostrip");
  const ctas = split.querySelector(".ctas");
  expect(ctas?.querySelectorAll(".bigplay").length).toBe(3);
});
