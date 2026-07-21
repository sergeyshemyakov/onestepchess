import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import type { Meta } from "../api/schemas.js";
import type { ConnectedWallet } from "../wallet/provider.js";
import { guardFallbackTxn } from "./guards.js";
import { loginWithWallet } from "./login.js";

const MAINNET_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const account = algosdk.generateAccount();
const other = algosdk.generateAccount();
const ADDRESS = account.addr.toString();
const NONCE = "abc123";

type TxnTweaks = {
  readonly sender?: string;
  readonly receiver?: string;
  readonly amount?: number;
  readonly fee?: number;
  readonly note?: string;
  readonly firstValid?: number;
  readonly lastValid?: number;
  readonly genesisHash?: string;
  readonly closeRemainderTo?: string;
  readonly rekeyTo?: string;
  readonly lease?: Uint8Array;
  readonly group?: boolean;
};

function fallbackTxnB64(tweaks: TxnTweaks = {}): string {
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: tweaks.sender ?? ADDRESS,
    receiver: tweaks.receiver ?? ADDRESS,
    amount: tweaks.amount ?? 0,
    note: new TextEncoder().encode(tweaks.note ?? `osc-auth:${NONCE}`),
    ...(tweaks.closeRemainderTo === undefined
      ? {}
      : { closeRemainderTo: tweaks.closeRemainderTo }),
    ...(tweaks.rekeyTo === undefined ? {} : { rekeyTo: tweaks.rekeyTo }),
    ...(tweaks.lease === undefined ? {} : { lease: tweaks.lease }),
    suggestedParams: {
      flatFee: true,
      fee: tweaks.fee ?? 0,
      minFee: 1_000,
      firstValid: tweaks.firstValid ?? 1,
      lastValid: tweaks.lastValid ?? 1,
      genesisHash: new Uint8Array(
        Buffer.from(tweaks.genesisHash ?? MAINNET_HASH, "base64"),
      ),
      genesisID: "mainnet-v1.0",
    },
  });
  if (tweaks.group === true) {
    txn.group = new Uint8Array(32).fill(7);
  }
  return Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64");
}

const guardInput = (
  fallbackTxn: string,
  caip2 = `algorand:${MAINNET_HASH}`,
) => ({
  fallbackTxnB64: fallbackTxn,
  address: ADDRESS,
  nonce: NONCE,
  caip2,
});

describe("fallback-txn pre-sign guard matrix (F-W2)", () => {
  it("accepts the exact pinned field set", () => {
    expect(guardFallbackTxn(algosdk, guardInput(fallbackTxnB64())).ok).toBe(
      true,
    );
  });

  it("skips the genesis check on mock:local only", () => {
    const testnetHashTxn = fallbackTxnB64({
      genesisHash: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
    });
    expect(
      guardFallbackTxn(algosdk, guardInput(testnetHashTxn, "mock:local")).ok,
    ).toBe(true);
    expect(guardFallbackTxn(algosdk, guardInput(testnetHashTxn))).toMatchObject(
      { ok: false, field: "genesis" },
    );
  });

  const rejections: readonly [string, TxnTweaks, string][] = [
    [
      "sender differs from the connected address",
      { sender: other.addr.toString() },
      "sender",
    ],
    [
      "receiver differs from sender",
      { receiver: other.addr.toString() },
      "receiver",
    ],
    ["non-zero amount", { amount: 1 }, "amount"],
    ["non-zero fee", { fee: 1_000 }, "fee"],
    ["wrong note", { note: "osc-auth:othernonce" }, "note"],
    ["live validity window", { firstValid: 10, lastValid: 1_000 }, "validity"],
    [
      "wrong genesis hash",
      { genesisHash: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" },
      "genesis",
    ],
    ["close-to set", { closeRemainderTo: other.addr.toString() }, "close"],
    ["rekey set", { rekeyTo: other.addr.toString() }, "rekey"],
    ["lease set", { lease: new Uint8Array(32).fill(3) }, "lease"],
    ["grouped txn", { group: true }, "group"],
  ];

  for (const [label, tweaks, field] of rejections) {
    it(`rejects ${label} before any signer`, () => {
      expect(
        guardFallbackTxn(algosdk, guardInput(fallbackTxnB64(tweaks))),
      ).toMatchObject({ ok: false, field });
    });
  }

  it("rejects a sender that is not the connected address", () => {
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: other.addr.toString(),
      receiver: other.addr.toString(),
      amount: 0,
      note: new TextEncoder().encode(`osc-auth:${NONCE}`),
      suggestedParams: {
        flatFee: true,
        fee: 0,
        minFee: 1_000,
        firstValid: 1,
        lastValid: 1,
        genesisHash: new Uint8Array(Buffer.from(MAINNET_HASH, "base64")),
        genesisID: "mainnet-v1.0",
      },
    });
    const b64 = Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString(
      "base64",
    );
    expect(guardFallbackTxn(algosdk, guardInput(b64))).toMatchObject({
      ok: false,
      field: "sender",
    });
  });

  it("rejects undecodable bytes", () => {
    expect(guardFallbackTxn(algosdk, guardInput("bm90LWEtdHhu"))).toMatchObject(
      {
        ok: false,
        field: "decode",
      },
    );
  });

  it("fallback_auth_guards_every_field_before_wallet_signing", async () => {
    const meta = { network: { caip2: `algorand:${MAINNET_HASH}` } } as Meta;
    for (const [label, tweaks, field] of rejections) {
      const signTransactions = vi.fn();
      const client = {
        authChallenge: vi.fn(async () => ({
          nonce: NONCE,
          expiresAt: "2026-07-21T15:00:00Z",
          arc60Payload: {
            data: "e30=",
            metadata: { scope: 1, encoding: "base64" },
          },
          fallbackTxnB64: fallbackTxnB64(tweaks),
        })),
        authVerify: vi.fn(),
      };
      const outcome = await loginWithWallet({
        // biome-ignore lint/suspicious/noExplicitAny: focused auth client double
        client: client as any,
        meta,
        wallet: {
          address: ADDRESS,
          walletName: "guard spy",
          signTransactions,
        },
      });
      expect(outcome, label).toMatchObject({ kind: "error" });
      expect(
        signTransactions,
        `${field} reached the wallet`,
      ).not.toHaveBeenCalled();
      expect(
        client.authVerify,
        `${field} reached verify`,
      ).not.toHaveBeenCalled();
    }
  });
});

describe("login flow signing spy (F-W2)", () => {
  const meta = { network: { caip2: `algorand:${MAINNET_HASH}` } } as Meta;

  function clientWithChallenge(fallbackTxn: string) {
    return {
      authChallenge: vi.fn(async () => ({
        nonce: NONCE,
        expiresAt: "2026-07-17T14:00:00Z",
        arc60Payload: {
          data: "e30=",
          metadata: { scope: 1, encoding: "base64" },
        },
        fallbackTxnB64: fallbackTxn,
      })),
      authVerify: vi.fn(async () => {
        throw new Error("should not verify");
      }),
    };
  }

  it("a guarded-field mismatch produces no signature at all", async () => {
    const client = clientWithChallenge(fallbackTxnB64({ amount: 1 }));
    const signSpy = vi.fn();
    const wallet: ConnectedWallet = {
      address: ADDRESS,
      walletName: "test",
      signTransactions: signSpy,
    };
    const outcome = await loginWithWallet({
      // biome-ignore lint/suspicious/noExplicitAny: partial client double
      client: client as any,
      meta,
      wallet,
    });
    expect(outcome).toMatchObject({ kind: "error" });
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("wallet-reject maps to a rejected outcome with no verify call", async () => {
    const client = clientWithChallenge(fallbackTxnB64());
    const wallet: ConnectedWallet = {
      address: ADDRESS,
      walletName: "test",
      signTransactions: vi.fn(async () => {
        throw new Error("user rejected");
      }),
    };
    const outcome = await loginWithWallet({
      // biome-ignore lint/suspicious/noExplicitAny: partial client double
      client: client as any,
      meta,
      wallet,
    });
    expect(outcome).toEqual({ kind: "rejected" });
    expect(client.authVerify).not.toHaveBeenCalled();
  });
});
