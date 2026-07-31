import algosdk from "algosdk";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../api/http.js";
import type { Meta } from "../api/schemas.js";
import { bytesToBase64, submitStarterStakeOptIn } from "./optin.js";
import type { ConnectedWallet } from "./provider.js";

const account = algosdk.generateAccount();
const other = algosdk.generateAccount();
const CAIP2 = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const meta = {
  network: { caip2: CAIP2, usdcAssetId: "10458941" },
} as Meta;

afterEach(() => vi.restoreAllMocks());

function transaction(firstValid = 20_000): algosdk.Transaction {
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    assetIndex: 10_458_941,
    suggestedParams: {
      flatFee: true,
      fee: 1_000,
      minFee: 1_000,
      firstValid,
      lastValid: firstValid + 1_000,
      genesisID: "testnet-v1.0",
      genesisHash: new Uint8Array(
        Buffer.from(CAIP2.slice("algorand:".length), "base64"),
      ),
    },
  });
}

function unsigned(txn = transaction()): string {
  return bytesToBase64(algosdk.encodeUnsignedTransaction(txn));
}

function connectedWallet(
  signTransactions = vi.fn(async ([txn]: readonly algosdk.Transaction[]) => {
    if (txn === undefined) throw new Error("missing txn");
    return txn.signTxn(account.sk);
  }),
): ConnectedWallet {
  return {
    address: account.addr.toString(),
    walletName: "fixture",
    signTransactions,
  };
}

function mutate(change: (txn: algosdk.Transaction) => void): string {
  const txn = transaction();
  change(txn);
  return unsigned(txn);
}

it("starter_stake_optin_rejects_every_unsafe_transaction_before_wallet_approval", async () => {
  const unsafe = [
    mutate((txn) => Reflect.set(txn, "sender", other.addr)),
    mutate((txn) =>
      Reflect.set(txn.assetTransfer ?? {}, "receiver", other.addr),
    ),
    mutate((txn) => Reflect.set(txn.assetTransfer ?? {}, "amount", 1n)),
    mutate((txn) => Reflect.set(txn.assetTransfer ?? {}, "assetIndex", 1n)),
    mutate((txn) => Reflect.set(txn, "genesisHash", new Uint8Array(32))),
    mutate((txn) => Reflect.set(txn, "fee", 2_000n)),
    mutate((txn) => Reflect.set(txn, "lastValid", txn.firstValid + 1_001n)),
    mutate((txn) => Reflect.set(txn, "group", new Uint8Array(32).fill(1))),
    mutate((txn) => Reflect.set(txn, "lease", new Uint8Array(32).fill(1))),
    mutate((txn) => Reflect.set(txn, "note", new Uint8Array([1]))),
    mutate((txn) => Reflect.set(txn, "rekeyTo", other.addr)),
    mutate((txn) =>
      Reflect.set(txn.assetTransfer ?? {}, "closeRemainderTo", other.addr),
    ),
    mutate((txn) =>
      Reflect.set(txn.assetTransfer ?? {}, "assetSender", other.addr),
    ),
  ];
  for (const unsignedTxnB64 of unsafe) {
    const getWallet = vi.fn(async () => connectedWallet());
    const submitBonusOptIn = vi.fn();
    await expect(
      submitStarterStakeOptIn({
        client: {
          getBonusOptInTxn: vi.fn(async () => unsignedTxnB64),
          submitBonusOptIn,
        },
        address: account.addr.toString(),
        meta,
        getWallet,
      }),
    ).rejects.toThrow();
    expect(getWallet).not.toHaveBeenCalled();
    expect(submitBonusOptIn).not.toHaveBeenCalled();
  }
});

it("starter_stake_optin_signs_and_relays_once_then_waits_for_server_observation", async () => {
  for (const relay of [
    vi.fn(async () => undefined),
    vi.fn(async () => {
      throw new TypeError("response lost");
    }),
  ]) {
    const signer = vi.fn(async ([txn]: readonly algosdk.Transaction[]) => {
      if (txn === undefined) throw new Error("missing txn");
      return txn.signTxn(account.sk);
    });
    await expect(
      submitStarterStakeOptIn({
        client: {
          getBonusOptInTxn: vi.fn(async () => unsigned()),
          submitBonusOptIn: relay,
        },
        address: account.addr.toString(),
        meta,
        getWallet: vi.fn(async () => connectedWallet(signer)),
      }),
    ).resolves.toBe("watching");
    expect(signer).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenCalledTimes(1);
  }
});

it("starter_stake_wallet_rejection_or_expired_params_rearms_with_a_fresh_unsigned_transaction", async () => {
  const getBonusOptInTxn = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce(unsigned(transaction(20_000)))
    .mockResolvedValueOnce(unsigned(transaction(21_000)))
    .mockResolvedValueOnce(unsigned(transaction(22_000)))
    .mockResolvedValueOnce(unsigned(transaction(23_000)));
  const cancelled = new Error("cancelled");
  cancelled.name = "AbortError";
  const sign = vi
    .fn<(txns: readonly algosdk.Transaction[]) => Promise<Uint8Array>>()
    .mockRejectedValueOnce(cancelled)
    .mockImplementation(async ([txn]) => {
      if (txn === undefined) throw new Error("missing txn");
      return txn.signTxn(account.sk);
    });
  const submitBonusOptIn = vi
    .fn<(signed: string) => Promise<void>>()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      new ApiError(
        400,
        { error: "OPTIN_INVALID", hint: "validity expired", docs: "" },
        null,
        new Headers(),
      ),
    )
    .mockResolvedValueOnce(undefined);
  const args = {
    client: { getBonusOptInTxn, submitBonusOptIn },
    address: account.addr.toString(),
    meta,
    getWallet: vi.fn(async () => connectedWallet(sign)),
  };
  await expect(submitStarterStakeOptIn(args)).rejects.toMatchObject({
    name: "AbortError",
  });
  await expect(submitStarterStakeOptIn(args)).resolves.toBe("watching");
  await expect(submitStarterStakeOptIn(args)).rejects.toMatchObject({
    code: "OPTIN_INVALID",
  });
  await expect(submitStarterStakeOptIn(args)).resolves.toBe("watching");
  expect(getBonusOptInTxn).toHaveBeenCalledTimes(4);
});
