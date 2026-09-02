import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import algosdk from "algosdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, type AuthHandlers } from "./App.jsx";
import { PhosphorToggle } from "./components/AppShell.jsx";
import { readTheme } from "./lib/storage.js";
import { metaFixture, mockClient, playerFixture } from "./test/fixtures.jsx";
import { resetWalletModuleForTests } from "./wallet/lazy.js";
import type { ConnectedWallet, WalletModule } from "./wallet/provider.js";

const walletModuleMock: { current: WalletModule | null } = { current: null };

vi.mock("./wallet/provider.js", () => ({
  createWalletModule: () => {
    if (walletModuleMock.current === null) throw new Error("no wallet mock");
    return walletModuleMock.current;
  },
}));

afterEach(() => {
  cleanup();
  resetWalletModuleForTests();
  walletModuleMock.current = null;
  localStorage.clear();
  sessionStorage.clear();
});

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

const handlers: AuthHandlers = { onUnauthorized: () => undefined };

describe("shell + router (#27)", () => {
  it("renders the landing at / and the shared NotFound elsewhere", async () => {
    const client = mockClient({
      probeProfile: vi.fn(async () => null),
    } as never);
    const view = render(<App client={client} authHandlers={handlers} />);
    await screen.findByText("ONE STEP CHESS");
    await screen.findByRole("heading", {
      name: /ONLY ONE MOVE\./,
    });
    expect(
      screen.getByText(/built for the x402 global challenge/),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "ONE STEP CHESS home" })
        .getAttribute("href"),
    ).toBe("/");
    const algorandLinks = screen.getAllByRole("link", {
      name: "Algorand website",
    });
    expect(algorandLinks).toHaveLength(2);
    for (const link of algorandLinks) {
      expect(link.getAttribute("href")).toBe("https://algorand.co/");
    }
    await screen.findByRole("button", { name: /▸ LOG IN/ });
    view.unmount();

    window.history.pushState({}, "", "/definitely-not-a-route");
    render(<App client={client} authHandlers={handlers} />);
    await screen.findByText("[ NO SIGNAL ]");
    expect(screen.getByText(/nothing at this address/)).not.toBeNull();
  });

  it("SystemBanner reflects /meta.status on load, before any SSE exists", async () => {
    const client = mockClient({
      probeProfile: vi.fn(async () => null),
      getMeta: vi.fn(async () => ({
        ...metaFixture,
        status: { mode: "paused" as const, banner: "maintenance window" },
      })),
    } as never);
    render(<App client={client} authHandlers={handlers} />);
    const banner = await screen.findByText(/settlement offline/);
    expect(banner.textContent).toContain("maintenance window");
    expect(banner.className).toBe("banner");
  });
});

describe("theme toggle (#27)", () => {
  it("keeps the green-amber-ice toggle at a constant width", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(dir, "styles/components.css"), "utf8");
    render(<PhosphorToggle />);
    expect(screen.getByRole("button").className).toContain("theme-toggle");
    expect(css).toMatch(/\.theme-toggle \{\s*width: 106px/);
  });

  it("persists to osc.theme and applies data-theme on <html>", () => {
    render(<PhosphorToggle />);
    const button = screen.getByRole("button", { name: /phosphor theme/ });
    fireEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe("amber");
    expect(localStorage.getItem("osc.theme")).toBe("amber");
    fireEvent.click(button);
    expect(readTheme()).toBe("ice");
    fireEvent.click(button);
    expect(readTheme()).toBe("green");
  });
});

describe("boot probe (#28)", () => {
  it("200 → session in: the hub renders directly", async () => {
    const client = mockClient();
    render(<App client={client} authHandlers={handlers} />);
    await screen.findByRole("button", { name: /▸ PLAY/ });
    expect(screen.getByText(/night-owl/)).not.toBeNull();
  });

  it("401 → session out: the landing renders", async () => {
    const client = mockClient({
      probeProfile: vi.fn(async () => null),
    } as never);
    render(<App client={client} authHandlers={handlers} />);
    await screen.findByRole("button", { name: /▸ LOG IN/ });
    expect(screen.queryByRole("button", { name: /▸ PLAY/ })).toBeNull();
  });
});

describe("wallet auth flow (#28)", () => {
  const account = algosdk.generateAccount();

  function fallbackTxnB64(nonce: string): string {
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: account.addr.toString(),
      receiver: account.addr.toString(),
      amount: 0,
      note: new TextEncoder().encode(`osc-auth:${nonce}`),
      suggestedParams: {
        flatFee: true,
        fee: 0,
        minFee: 1_000,
        firstValid: 1,
        lastValid: 1,
        genesisHash: new Uint8Array(
          Buffer.from("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "base64"),
        ),
        genesisID: "mainnet-v1.0",
      },
    });
    return Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString(
      "base64",
    );
  }

  function walletModule(wallet: ConnectedWallet): WalletModule {
    return {
      listWallets: () => [{ id: "mnemonic", name: "dev wallet (mnemonic)" }],
      connect: vi.fn(async () => wallet),
      current: () => null,
      disconnect: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
    };
  }

  it("challenge → guarded sign → verify: the very next render is the hub", async () => {
    const signSpy = vi.fn(async (txns: readonly algosdk.Transaction[]) => {
      const txn = txns[0];
      if (txn === undefined) throw new Error("nothing to sign");
      return txn.signTxn(account.sk);
    });
    walletModuleMock.current = walletModule({
      address: account.addr.toString(),
      walletName: "dev",
      signTransactions: signSpy,
    });
    const client = mockClient({
      probeProfile: vi.fn(async () => null),
      authChallenge: vi.fn(async () => ({
        nonce: "nonce1",
        expiresAt: "2026-07-17T14:00:00Z",
        arc60Payload: {
          data: "e30=",
          metadata: { scope: 1, encoding: "base64" },
        },
        fallbackTxnB64: fallbackTxnB64("nonce1"),
      })),
      authVerify: vi.fn(async () => ({ player: playerFixture, jwt: "jwt" })),
    } as never);

    render(<App client={client} authHandlers={handlers} />);
    fireEvent.click(await screen.findByRole("button", { name: /▸ LOG IN/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /dev wallet \(mnemonic\)/ }),
    );
    // Straight to the hub — no interstitial.
    await screen.findByRole("button", { name: /▸ PLAY/ });
    expect(signSpy).toHaveBeenCalledTimes(1);
    const verify = client.authVerify as ReturnType<typeof vi.fn>;
    expect(verify.mock.calls[0]?.[0]).toMatchObject({
      address: account.addr.toString(),
      method: "txn",
    });
  });

  it("wallet_connection_swaps_the_wallet_list_for_a_waiting_state_before_requesting_the_signature", async () => {
    let releaseChallenge:
      | ((challenge: {
          nonce: string;
          expiresAt: string;
          arc60Payload: {
            data: string;
            metadata: { scope: number; encoding: string };
          };
          fallbackTxnB64: string;
        }) => void)
      | undefined;
    const signTransactions = vi.fn(
      async (txns: readonly algosdk.Transaction[]) => {
        const txn = txns[0];
        if (txn === undefined) throw new Error("nothing to sign");
        return txn.signTxn(account.sk);
      },
    );
    walletModuleMock.current = walletModule({
      address: account.addr.toString(),
      walletName: "Pera",
      signTransactions,
    });
    const client = mockClient({
      probeProfile: vi.fn(async () => null),
      authChallenge: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseChallenge = resolve;
          }),
      ),
      authVerify: vi.fn(async () => ({ player: playerFixture, jwt: "jwt" })),
    } as never);

    render(<App client={client} authHandlers={handlers} />);
    fireEvent.click(await screen.findByRole("button", { name: /▸ LOG IN/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /dev wallet \(mnemonic\)/ }),
    );

    await waitFor(() => {
      expect(client.authChallenge).toHaveBeenCalledTimes(1);
      // The wallet list is gone (no double-trigger), replaced by a visible
      // waiting state instead of an empty screen while the wallet signs.
      expect(
        screen.queryByRole("button", { name: /dev wallet \(mnemonic\)/ }),
      ).toBeNull();
      expect(screen.getByText(/approve the sign-in request/i)).not.toBeNull();
    });

    releaseChallenge?.({
      nonce: "nonce-sheet-close",
      expiresAt: "2026-07-17T14:00:00Z",
      arc60Payload: {
        data: "e30=",
        metadata: { scope: 1, encoding: "base64" },
      },
      fallbackTxnB64: fallbackTxnB64("nonce-sheet-close"),
    });
    await screen.findByRole("button", { name: /▸ PLAY/ });
    expect(signTransactions).toHaveBeenCalledTimes(1);
  });

  it("wallet-reject at signing returns to the landing with no state change", async () => {
    walletModuleMock.current = walletModule({
      address: account.addr.toString(),
      walletName: "dev",
      signTransactions: vi.fn(async () => {
        throw new Error("user rejected");
      }),
    });
    const probeProfile = vi.fn(async () => null);
    const client = mockClient({
      probeProfile,
      authChallenge: vi.fn(async () => ({
        nonce: "nonce2",
        expiresAt: "2026-07-17T14:00:00Z",
        arc60Payload: {
          data: "e30=",
          metadata: { scope: 1, encoding: "base64" },
        },
        fallbackTxnB64: fallbackTxnB64("nonce2"),
      })),
      authVerify: vi.fn(),
    } as never);

    render(<App client={client} authHandlers={handlers} />);
    fireEvent.click(await screen.findByRole("button", { name: /▸ LOG IN/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /dev wallet \(mnemonic\)/ }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // Landing intact, no verify attempted, session untouched.
    expect(screen.getByRole("button", { name: /▸ LOG IN/ })).not.toBeNull();
    expect(client.authVerify).not.toHaveBeenCalled();
    expect(probeProfile).toHaveBeenCalledTimes(1);
  });

  it("unexpected wallet sign-in failure stays open for another attempt", async () => {
    const module = walletModule({
      address: account.addr.toString(),
      walletName: "dev",
      signTransactions: vi.fn(),
    });
    walletModuleMock.current = module;
    const client = mockClient({
      probeProfile: vi.fn(async () => null),
      authChallenge: vi.fn(async () => {
        throw new Error("server unavailable");
      }),
    } as never);

    render(<App client={client} authHandlers={handlers} />);
    fireEvent.click(await screen.findByRole("button", { name: /▸ LOG IN/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /dev wallet \(mnemonic\)/ }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "wallet sign-in failed",
    );
    expect(
      screen.getByRole("dialog", { name: "connect wallet" }),
    ).not.toBeNull();
    expect(module.disconnect).toHaveBeenCalledTimes(1);
  });
});
