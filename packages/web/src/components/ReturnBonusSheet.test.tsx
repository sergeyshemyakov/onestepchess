import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import algosdk from "algosdk";
import { afterEach, expect, it, vi } from "vitest";
import type { BonusSweepQuote } from "../api/schemas.js";
import { mockClient, Providers } from "../test/fixtures.jsx";
import { ReturnBonusSheet } from "./ReturnBonusSheet.jsx";

const MAINNET_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const account = algosdk.generateAccount();
const bonus = algosdk.generateAccount().addr.toString();

vi.mock("../wallet/lazy.js", () => ({
  loadWalletModule: async () => ({
    listWallets: () => [],
    current: () => ({
      address: account.addr.toString(),
      walletName: "dev",
      signTransactions: async (txns: readonly algosdk.Transaction[]) => {
        const first = txns[0];
        if (first === undefined) throw new Error("nothing to sign");
        return first.signTxn(account.sk);
      },
    }),
    connect: async () => {
      throw new Error("unused");
    },
    disconnect: async () => undefined,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function quoteFixture(): BonusSweepQuote {
  const suggestedParams = {
    flatFee: true,
    fee: 1_000,
    minFee: 1_000,
    firstValid: 10_000,
    lastValid: 11_000,
    genesisID: "mainnet-v1.0",
    genesisHash: new Uint8Array(Buffer.from(MAINNET_HASH, "base64")),
  };
  const usdc = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: bonus,
    amount: 180_000,
    assetIndex: 31_566_704,
    note: new TextEncoder().encode(`osc:sweep:usdc:${account.addr.toString()}`),
    suggestedParams,
  });
  const algo = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: bonus,
    amount: 248_000,
    note: new TextEncoder().encode(`osc:sweep:algo:${account.addr.toString()}`),
    suggestedParams,
  });
  return {
    receiver: bonus,
    txns: [
      {
        leg: "usdc",
        unsignedTxnB64: Buffer.from(
          algosdk.encodeUnsignedTransaction(usdc),
        ).toString("base64"),
        amount: 180_000,
      },
      {
        leg: "algo",
        unsignedTxnB64: Buffer.from(
          algosdk.encodeUnsignedTransaction(algo),
        ).toString("base64"),
        amount: 248_000,
      },
    ],
  };
}

it("quotes the return, signs both legs on confirm, and reports success", async () => {
  const submitBonusSweep = vi.fn(async (_signed: readonly string[]) => ({
    status: "submitted" as const,
    txids: [
      { leg: "usdc" as const, txid: "tx1" },
      { leg: "algo" as const, txid: "tx2" },
    ],
  }));
  const client = mockClient({
    getBonusSweepTxns: vi.fn(async () => quoteFixture()),
    submitBonusSweep,
  } as never);
  const onReturned = vi.fn();

  render(
    <Providers client={client}>
      <ReturnBonusSheet
        client={client}
        address={account.addr.toString()}
        onClose={() => undefined}
        onReturned={onReturned}
      />
    </Providers>,
  );

  expect(
    (await screen.findByTestId("return-bonus-amounts")).textContent,
  ).toContain("$0.18 USDC · 0.248 ALGO");
  fireEvent.click(screen.getByRole("button", { name: /return it/ }));

  await screen.findByTestId("return-bonus-done");
  expect(submitBonusSweep).toHaveBeenCalledTimes(1);
  const signed = submitBonusSweep.mock.calls[0]?.[0] ?? [];
  expect(signed).toHaveLength(2);
  for (const leg of signed) {
    const decoded = algosdk.decodeSignedTransaction(
      new Uint8Array(Buffer.from(leg, "base64")),
    );
    expect(decoded.txn.sender.toString()).toBe(account.addr.toString());
  }
  expect(onReturned).toHaveBeenCalledTimes(1);
});

it("says so when there is nothing left to return", async () => {
  const client = mockClient({
    getBonusSweepTxns: vi.fn(async () => ({ receiver: bonus, txns: [] })),
    submitBonusSweep: vi.fn(),
  } as never);

  render(
    <Providers client={client}>
      <ReturnBonusSheet
        client={client}
        address={account.addr.toString()}
        onClose={() => undefined}
        onReturned={() => undefined}
      />
    </Providers>,
  );

  await screen.findByText(/nothing left to return/);
  expect(screen.queryByRole("button", { name: /return it/ })).toBeNull();
});
