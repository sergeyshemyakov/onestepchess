import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import algosdk from "algosdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { ToastProvider } from "../components/Toasts.jsx";
import { metaFixture, mockClient, playerFixture } from "../test/fixtures.jsx";
import type { ConnectedWallet } from "../wallet/provider.js";
import { ConnectSheet } from "./ConnectSheet.jsx";

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn<() => Promise<ConnectedWallet>>(),
}));

vi.mock("../wallet/lazy.js", () => ({
  loadWalletModule: vi.fn(async () => ({
    listWallets: () => [{ id: "pera", name: "Pera" }],
    connect: connectMock,
    current: () => null,
    disconnect: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
  })),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  connectMock.mockReset();
  connectMock.mockResolvedValue({
    address: "PERA_ADDRESS",
    walletName: "Pera",
    signTransactions: vi.fn(async () => new Uint8Array()),
  });
});

function renderSheet(client: ReturnType<typeof mockClient>) {
  const onSignedIn = vi.fn();
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <ConnectSheet
        client={client}
        meta={metaFixture}
        onSignedIn={onSignedIn}
        onClose={onClose}
      />
    </ToastProvider>,
  );
  return { onSignedIn, onClose };
}

async function pickPera() {
  const button = await screen.findByRole("button", { name: /▸ Pera/ });
  fireEvent.click(button);
}

describe("connect sheet failure feedback (F-W2)", () => {
  it("surfaces_the_server_hint_when_the_challenge_request_fails", async () => {
    const client = mockClient({
      authChallenge: vi.fn(async () => {
        throw new ApiError(
          429,
          {
            error: "RATE_LIMITED",
            hint: "too many auth requests from this address",
            docs: "",
          },
          null,
          new Headers(),
        );
      }),
    });
    renderSheet(client);
    await pickPera();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "too many auth requests from this address",
    );
  });

  it("shows_a_waiting_state_while_signing_and_verifying", async () => {
    const client = mockClient({
      authChallenge: vi.fn(() => new Promise<never>(() => undefined)),
    });
    renderSheet(client);
    await pickPera();
    expect(
      await screen.findByText(/approve the sign-in request/i),
    ).not.toBeNull();
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("backing_out_of_the_waiting_state_discards_a_late_login_result", async () => {
    const account = algosdk.generateAccount();
    connectMock.mockResolvedValue({
      address: account.addr.toString(),
      walletName: "Pera",
      signTransactions: vi.fn(async (txns: readonly algosdk.Transaction[]) => {
        const txn = txns[0];
        if (txn === undefined) throw new Error("nothing to sign");
        return txn.signTxn(account.sk);
      }),
    });
    let releaseChallenge: ((challenge: unknown) => void) | undefined;
    const client = mockClient({
      authChallenge: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseChallenge = resolve;
          }),
      ),
      authVerify: vi.fn(async () => ({ player: playerFixture, jwt: "jwt" })),
    } as never);
    const { onSignedIn, onClose } = renderSheet(client);
    await pickPera();
    await screen.findByText(/approve the sign-in request/i);
    fireEvent.click(screen.getByRole("button", { name: "← back" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const address = account.addr.toString();
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: address,
      receiver: address,
      amount: 0,
      note: new TextEncoder().encode("osc-auth:nonce-late"),
      suggestedParams: {
        flatFee: true,
        fee: 0,
        minFee: 1_000,
        firstValid: 1,
        lastValid: 1,
        genesisHash: new Uint8Array(32),
        genesisID: "mainnet-v1.0",
      },
    });
    releaseChallenge?.({
      nonce: "nonce-late",
      expiresAt: "2026-09-02T15:00:00Z",
      arc60Payload: {
        data: "e30=",
        metadata: { scope: 1, encoding: "base64" },
      },
      fallbackTxnB64: Buffer.from(
        algosdk.encodeUnsignedTransaction(txn),
      ).toString("base64"),
    });
    await waitFor(() => expect(client.authVerify).toHaveBeenCalledTimes(1));
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
