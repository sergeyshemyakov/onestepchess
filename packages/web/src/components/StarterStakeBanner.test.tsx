import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../api/http.js";
import type { BonusStatus, ProfileView } from "../api/schemas.js";
import { metaFixture, mockClient, profileFixture } from "../test/fixtures.jsx";
import type { ConnectedWallet } from "../wallet/provider.js";
import { StarterStakeBanner } from "./StarterStakeBanner.jsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function profile(status?: BonusStatus): ProfileView {
  return profileFixture(status === undefined ? {} : { bonus: { status } });
}

function apiError(error: string, hint: string, status = 400): ApiError {
  return new ApiError(status, { error, hint, docs: "" }, null, new Headers());
}

function wallet(): ConnectedWallet {
  return {
    address: profileFixture().address,
    walletName: "fixture",
    signTransactions: vi.fn(),
  };
}

function banner(
  input: {
    readonly status?: BonusStatus;
    readonly profile?: ProfileView;
    readonly client?: ReturnType<typeof mockClient>;
    readonly getWallet?: () => Promise<ConnectedWallet>;
    readonly onRefresh?: () => void;
  } = {},
) {
  const client = input.client ?? mockClient();
  const getWallet = input.getWallet ?? vi.fn(async () => wallet());
  const onRefresh = input.onRefresh ?? vi.fn();
  const props = {
    client,
    meta: metaFixture,
    profile: input.profile ?? profile(input.status),
    getWallet,
    onRefresh,
  };
  return { ...render(<StarterStakeBanner {...props} />), props };
}

it("starter_stake_live_funding_waits_for_an_explicit_continue_before_showing_the_final_step", () => {
  const view = banner();
  expect(screen.queryByLabelText("starter stake")).toBeNull();

  view.rerender(
    <StarterStakeBanner {...view.props} profile={profile("available")} />,
  );
  expect(screen.getByRole("button", { name: "CLAIM ▸" })).not.toBeNull();
  view.rerender(
    <StarterStakeBanner {...view.props} profile={profile("claimed")} />,
  );
  expect(screen.getByText(/ALGO transfer queued/)).not.toBeNull();
  expect(screen.getByRole("button", { name: "ENABLE USDC ▸" })).not.toBeNull();
  view.rerender(
    <StarterStakeBanner
      {...view.props}
      profile={profileFixture({
        bonus: { status: "claimed", algoReady: true },
      })}
    />,
  );
  expect(screen.getByText(/ALGO already available/)).not.toBeNull();
  view.rerender(
    <StarterStakeBanner
      {...view.props}
      profile={profileFixture({
        bonus: { status: "claimed", algoTxid: "ALGO_CONFIRMATION_TX" },
      })}
    />,
  );
  expect(screen.getByText(/ALGO arrived/)).not.toBeNull();
  expect(screen.getByRole("link", { name: "tx ↗" }).getAttribute("href")).toBe(
    "https://explorer.example/tx/ALGO_CONFIRMATION_TX",
  );
  view.rerender(
    <StarterStakeBanner {...view.props} profile={profile("opted_in")} />,
  );
  expect(screen.getByText(/sending your starter stake/)).not.toBeNull();
  view.rerender(
    <StarterStakeBanner {...view.props} profile={profile("funded")} />,
  );
  expect(screen.getByText(/USDC arrived/)).not.toBeNull();
  expect(screen.queryByText(/starter stake ready/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "CONTINUE ▸" }));
  expect(screen.getByText(/starter stake ready/)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "PLAY ▸" }));
  expect(screen.queryByLabelText("starter stake")).toBeNull();
  expect(localStorage.getItem("osc.bonusDone")).toBe("acked");
});

it("starter_stake_initial_snapshot_may_skip_directly_to_the_funded_step", () => {
  banner({ status: "funded" });

  expect(screen.getByText(/starter stake ready/)).not.toBeNull();
  expect(screen.queryByRole("button", { name: "CONTINUE ▸" })).toBeNull();
});

it("starter_stake_claim_is_single_flight_and_renders_server_envelope_hints", async () => {
  let finish: (() => void) | undefined;
  const claimBonus = vi.fn(
    () =>
      new Promise<{ bonus: { status: "claimed"; claimedAt: string } }>(
        (resolve) => {
          finish = () =>
            resolve({
              bonus: {
                status: "claimed",
                claimedAt: "2026-07-31T10:00:00Z",
              },
            });
        },
      ),
  );
  const onRefresh = vi.fn();
  const view = banner({
    status: "available",
    client: mockClient({ claimBonus } as never),
    onRefresh,
  });
  const claim = screen.getByRole("button", { name: "CLAIM ▸" });
  fireEvent.click(claim);
  fireEvent.click(claim);
  expect(claimBonus).toHaveBeenCalledTimes(1);
  finish?.();
  await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  view.rerender(
    <StarterStakeBanner {...view.props} profile={profile("claimed")} />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "ENABLE USDC ▸",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);

  for (const [code, hint] of [
    ["BONUS_UNAVAILABLE", "today's starter stakes are gone — back tomorrow"],
    ["BONUS_UNAVAILABLE", "starter-stake program is temporarily disabled"],
    ["BONUS_NOT_ELIGIBLE", "starter stake is not available for this account"],
    ["UNAUTHENTICATED", "sign in again to continue"],
  ] as const) {
    cleanup();
    const rejectedClaim = vi.fn(async () => {
      throw apiError(code, hint);
    });
    banner({
      status: "available",
      client: mockClient({ claimBonus: rejectedClaim } as never),
    });
    fireEvent.click(screen.getByRole("button", { name: "CLAIM ▸" }));
    expect(await screen.findByText(hint)).not.toBeNull();
    expect(rejectedClaim).toHaveBeenCalledTimes(1);
  }
});

it("starter_stake_optin_double_click_stays_single_flight_while_loading_a_fresh_transaction", async () => {
  let releaseWallet: ((value: ConnectedWallet) => void) | undefined;
  const getWallet = vi.fn(
    () =>
      new Promise<ConnectedWallet>((resolve) => {
        releaseWallet = resolve;
      }),
  );
  const client = mockClient({
    getBonusOptInTxn: vi.fn(async () => "pending-guarded-by-module"),
  } as never);
  banner({ status: "claimed", client, getWallet });
  const enable = screen.getByRole("button", { name: "ENABLE USDC ▸" });
  fireEvent.click(enable);
  fireEvent.click(enable);
  await waitFor(() => expect(client.getBonusOptInTxn).toHaveBeenCalledTimes(1));
  releaseWallet?.(wallet());
});

it("starter_stake_banner_polls_for_progress_while_a_chain_transition_is_pending", () => {
  vi.useFakeTimers();
  try {
    const onRefresh = vi.fn();
    banner({ status: "opted_in", onRefresh });
    vi.advanceTimersByTime(12_000);
    expect(onRefresh.mock.calls.length).toBeGreaterThanOrEqual(2);

    cleanup();
    onRefresh.mockClear();
    banner({ status: "claimed", onRefresh });
    vi.advanceTimersByTime(12_000);
    expect(onRefresh).toHaveBeenCalled();

    cleanup();
    onRefresh.mockClear();
    banner({
      profile: profileFixture({
        bonus: { status: "claimed", algoTxid: "ALGO_CONFIRMATION_TX" },
      }),
      onRefresh,
    });
    vi.advanceTimersByTime(12_000);
    expect(onRefresh).not.toHaveBeenCalled();

    cleanup();
    banner({ status: "funded", onRefresh });
    vi.advanceTimersByTime(12_000);
    expect(onRefresh).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("starter_stake_flow_recovers_after_reload_app_switch_stream_reset_and_wallet_disconnect", () => {
  for (const status of ["claimed", "opted_in", "funded"] as const) {
    cleanup();
    banner({ status });
    expect(screen.getByLabelText("starter stake")).not.toBeNull();
  }
  expect(localStorage.getItem("osc.bonusDone")).toBeNull();
});

it("starter_stake_ui_is_absent_for_agents_guests_ineligible_humans_and_server_omission", () => {
  banner({
    profile: profileFixture({
      kind: "agent",
      bonus: { status: "available" },
      points: undefined,
      refCode: undefined,
      referrals: undefined,
    }),
  });
  expect(screen.queryByLabelText("starter stake")).toBeNull();
  cleanup();
  banner({ profile: profileFixture() });
  expect(screen.queryByLabelText("starter stake")).toBeNull();
});
