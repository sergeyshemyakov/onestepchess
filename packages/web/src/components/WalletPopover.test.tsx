import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { Hub } from "../routes/Hub.jsx";
import {
  metaFixture,
  mockClient,
  Providers,
  playerFixture,
  profileFixture,
} from "../test/fixtures.jsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

it("wallet_popover_fetches_balances_only_when_open", async () => {
  let releaseBalances: (() => void) | undefined;
  const balancesProfile = profileFixture({
    balances: { usdcMicroUsdc: 250_000, algoMicroAlgo: 750_000 },
  });
  const getProfile = vi.fn(
    async (options?: { readonly balances?: boolean }) => {
      if (options?.balances !== true) return profileFixture();
      await new Promise<void>((resolve) => {
        releaseBalances = resolve;
      });
      return balancesProfile;
    },
  );
  const renameProfile = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(
        409,
        {
          error: "NICKNAME_TAKEN",
          hint: "nickname already in use",
          docs: "",
          suggestion: "gentle-rook-777",
        },
        null,
        new Headers(),
      ),
    )
    .mockResolvedValue({ ...playerFixture, nickname: "gentle-rook-777" });
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const client = mockClient({ getProfile, renameProfile } as never);

  render(
    <Providers client={client}>
      <Hub client={client} meta={metaFixture} player={playerFixture} />
    </Providers>,
  );

  // -- The hub itself never requests balances.
  await screen.findByTestId("stats-chip");
  for (const call of getProfile.mock.calls) {
    expect(call[0]?.balances).not.toBe(true);
  }

  // -- Opening fetches balances; the slow fetch shows a stale marker
  //    instead of blocking the popover.
  fireEvent.click(screen.getByRole("button", { name: /night-owl/ }));
  const popover = await screen.findByTestId("wallet-popover");
  expect(getProfile.mock.calls.some((call) => call[0]?.balances === true)).toBe(
    true,
  );
  expect(screen.getByTestId("popover-balances").textContent).toContain(
    "may be stale",
  );
  (releaseBalances as unknown as () => void)();
  await waitFor(() => {
    expect(screen.getByTestId("popover-balances").textContent).toContain(
      "$0.25 USDC · 0.75 ALGO",
    );
  });

  // -- Points and referral counters from the same profile fetch.
  expect(screen.getByTestId("popover-points").textContent).toContain(
    "points: 120",
  );
  expect(screen.getByTestId("popover-invite").textContent).toContain(
    "2 joined · 1 qualified",
  );
  expect(screen.queryByRole("button", { name: /sfx:/i })).toBeNull();

  // -- Copy controls: address and the ref-bearing invite link.
  fireEvent.click(within(popover, "📋", 0));
  expect(writeText).toHaveBeenCalledWith(playerFixture.address);
  const inviteCopy = screen
    .getByTestId("popover-invite")
    .querySelector("button") as HTMLButtonElement;
  fireEvent.click(inviteCopy);
  expect(writeText).toHaveBeenLastCalledWith(
    `${window.location.origin}/?ref=gentle-rook-042`,
  );

  // -- Rename errors render inline without closing the popover; the
  //    suggestion is one-click.
  fireEvent.click(screen.getByRole("button", { name: "edit" }));
  fireEvent.change(screen.getByLabelText("nickname"), {
    target: { value: "taken-name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "save" }));
  await screen.findByText(/nickname already in use/);
  expect(screen.getByTestId("wallet-popover")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /use gentle-rook-777/ }));
  await waitFor(() => {
    expect(renameProfile).toHaveBeenLastCalledWith("gentle-rook-777");
  });

  // -- Logout drops the session via the popover.
  fireEvent.click(screen.getByRole("button", { name: "log out" }));
  await waitFor(() => {
    expect(client.authLogout).toHaveBeenCalledTimes(1);
  });
});

function within(host: HTMLElement, label: string, index: number): Element {
  const matches = [...host.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === label,
  );
  const found = matches[index];
  if (found === undefined) throw new Error(`no "${label}" button #${index}`);
  return found;
}
