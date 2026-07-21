import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MoveReceipt } from "../api/schemas.js";
import { resetTurnstileForTests } from "../auth/turnstile.js";
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

async function reachConfirm(view: ReturnType<typeof render>) {
  fireEvent.click(
    await screen.findByRole("button", { name: /PLAY A DEMO GAME/ }),
  );
  await screen.findByText(/YOU PLAY WHITE/);
  fireEvent.click(
    view.container.querySelector('[data-square="e2"]') as Element,
  );
  fireEvent.click(
    view.container.querySelector('[data-square="e4"]') as Element,
  );
  await screen.findByText("FINAL MOVE?");
}

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
  fireEvent.click(
    receiptView.container.querySelector('[data-square="e2"]') as Element,
  );
  fireEvent.click(
    receiptView.container.querySelector('[data-square="e4"]') as Element,
  );
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
  expect(localStorage.getItem("osc.guestDemo")).toBe("expired");
});
