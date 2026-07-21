import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App, type AuthHandlers } from "../App.jsx";
import type { PlayerView } from "../api/schemas.js";
import { mockClient, playerFixture } from "../test/fixtures.jsx";

vi.mock("../auth/ConnectSheet.jsx", () => ({
  ConnectSheet: (props: {
    readonly onSignedIn: (
      player: PlayerView,
      linkedGuestClaims?: number,
    ) => void;
  }) => (
    <button
      type="button"
      data-testid="stub-verify"
      onClick={() => props.onSignedIn(playerFixture, 0)}
    >
      stub verify
    </button>
  ),
}));

const handlers: AuthHandlers = { onUnauthorized: () => undefined };

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

function loggedOutClient() {
  return mockClient({ probeProfile: vi.fn(async () => null) } as never);
}

it("ref_capture_is_first_touch_and_cleans_url_without_reload", async () => {
  // -- Capture works on every route; the URL is cleaned via replaceState
  //    (no reload — the SPA keeps rendering) and other params survive.
  const routes = [
    { path: "/?ref=brave-knight-123", client: loggedOutClient() },
    { path: "/start?ref=brave-knight-123", client: loggedOutClient() },
    { path: "/championship?ref=brave-knight-123", client: loggedOutClient() },
    { path: "/archive?ref=brave-knight-123", client: mockClient() },
    {
      path: "/replay/gm_x?ply=3&ref=brave-knight-123",
      client: loggedOutClient(),
    },
    { path: "/nowhere?ref=brave-knight-123", client: loggedOutClient() },
  ];
  for (const route of routes) {
    window.history.replaceState({}, "", route.path);
    const view = render(<App client={route.client} authHandlers={handlers} />);
    await waitFor(() => {
      expect(localStorage.getItem("osc.ref")).toBe("brave-knight-123");
    });
    expect(window.location.search).not.toContain("ref=");
    if (route.path.includes("ply=")) {
      expect(window.location.search).toContain("ply=3");
    }
    view.unmount();
    localStorage.clear();
  }

  // -- Malformed values are dropped silently.
  window.history.replaceState(
    {},
    "",
    "/?ref=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
  );
  const malformed = render(
    <App client={loggedOutClient()} authHandlers={handlers} />,
  );
  await screen.findByRole("button", { name: /I HAVE AN ALGORAND WALLET/ });
  expect(localStorage.getItem("osc.ref")).toBeNull();
  malformed.unmount();

  // -- First touch wins: a later code never overwrites an earlier one.
  localStorage.setItem("osc.ref", "first-touch-001");
  window.history.replaceState({}, "", "/?ref=second-touch-002");
  const second = render(
    <App client={loggedOutClient()} authHandlers={handlers} />,
  );
  await screen.findByRole("button", { name: /I HAVE AN ALGORAND WALLET/ });
  expect(localStorage.getItem("osc.ref")).toBe("first-touch-001");
  expect(window.location.search).not.toContain("ref=");
  second.unmount();

  // -- A successful verify clears the stored code (attribution is
  //    registration-only).
  window.history.replaceState({}, "", "/");
  render(<App client={loggedOutClient()} authHandlers={handlers} />);
  fireEvent.click(
    await screen.findByRole("button", { name: /I HAVE AN ALGORAND WALLET/ }),
  );
  fireEvent.click(await screen.findByTestId("stub-verify"));
  await waitFor(() => {
    expect(localStorage.getItem("osc.ref")).toBeNull();
  });
});
