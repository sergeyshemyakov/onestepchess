import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { metaFixture } from "../test/fixtures.jsx";
import { guardBonusSweepTxn, UnsafeSweepError } from "./sweep.js";

const MAINNET_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const player = algosdk.generateAccount().addr.toString();
const bonus = algosdk.generateAccount().addr.toString();

type Tweaks = {
  readonly receiver?: string;
  readonly fee?: number;
  readonly note?: string;
  readonly closeRemainderTo?: string;
  readonly rekeyTo?: string;
  readonly assetIndex?: number;
};

function unsignedLeg(leg: "usdc" | "algo", tweaks: Tweaks = {}): string {
  const suggestedParams = {
    flatFee: true,
    fee: tweaks.fee ?? 1_000,
    minFee: 1_000,
    firstValid: 10_000,
    lastValid: 11_000,
    genesisID: "mainnet-v1.0",
    genesisHash: new Uint8Array(Buffer.from(MAINNET_HASH, "base64")),
  };
  const common = {
    sender: player,
    receiver: tweaks.receiver ?? bonus,
    note: new TextEncoder().encode(tweaks.note ?? `osc:sweep:${leg}:${player}`),
    ...(tweaks.rekeyTo === undefined ? {} : { rekeyTo: tweaks.rekeyTo }),
    ...(tweaks.closeRemainderTo === undefined
      ? {}
      : { closeRemainderTo: tweaks.closeRemainderTo }),
    suggestedParams,
  };
  const transaction =
    leg === "usdc"
      ? algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          ...common,
          amount: 150_000,
          assetIndex: tweaks.assetIndex ?? 31_566_704,
        })
      : algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          ...common,
          amount: 200_000,
        });
  return Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
    "base64",
  );
}

function guard(leg: "usdc" | "algo", tweaks: Tweaks = {}) {
  return guardBonusSweepTxn({
    unsignedTxnB64: unsignedLeg(leg, tweaks),
    leg,
    address: player,
    receiver: bonus,
    meta: metaFixture,
  });
}

describe("guardBonusSweepTxn", () => {
  it("accepts the exact server-built usdc and algo legs", () => {
    expect(guard("usdc").sender.toString()).toBe(player);
    expect(guard("algo").sender.toString()).toBe(player);
  });

  it("rejects a leg paying anywhere but the quoted receiver", () => {
    const elsewhere = algosdk.generateAccount().addr.toString();
    expect(() => guard("algo", { receiver: elsewhere })).toThrow(
      UnsafeSweepError,
    );
    expect(() => guard("usdc", { receiver: elsewhere })).toThrow(
      UnsafeSweepError,
    );
  });

  it("rejects close-outs, rekeys, wrong fees, assets, and notes", () => {
    const stranger = algosdk.generateAccount().addr.toString();
    expect(() => guard("algo", { closeRemainderTo: stranger })).toThrow(
      UnsafeSweepError,
    );
    expect(() => guard("usdc", { closeRemainderTo: stranger })).toThrow(
      UnsafeSweepError,
    );
    expect(() => guard("algo", { rekeyTo: stranger })).toThrow(
      UnsafeSweepError,
    );
    expect(() => guard("algo", { fee: 2_000 })).toThrow(UnsafeSweepError);
    expect(() => guard("usdc", { assetIndex: 42 })).toThrow(UnsafeSweepError);
    expect(() =>
      guard("algo", { note: "osc:sweep:algo:someone-else" }),
    ).toThrow(UnsafeSweepError);
  });

  it("rejects a leg whose type does not match its label", () => {
    expect(() =>
      guardBonusSweepTxn({
        unsignedTxnB64: unsignedLeg("algo"),
        leg: "usdc",
        address: player,
        receiver: bonus,
        meta: metaFixture,
      }),
    ).toThrow(UnsafeSweepError);
  });
});
