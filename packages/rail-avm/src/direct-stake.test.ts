import { RailError } from "@onestepchess/core";
import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import { createAvmRail, type RailDiagnostic } from "./rail.js";
import { accountConfig, json } from "./test-helpers.js";

const params = {
  flatFee: true,
  fee: 1_000,
  minFee: 1_000,
  firstValid: 20_000,
  lastValid: 20_020,
  genesisID: "fixture-v1",
  genesisHash: new Uint8Array(32).fill(7),
};

function msgpack(response: algosdk.modelsv2.PendingTransactionResponse) {
  return new Response(new Uint8Array(algosdk.encodeMsgpack(response)), {
    status: 200,
    headers: { "content-type": "application/msgpack" },
  });
}

function pendingResponse(
  transaction: algosdk.Transaction,
  signer: algosdk.Account,
  options: { confirmedRound?: number; poolError?: string } = {},
) {
  return msgpack(
    new algosdk.modelsv2.PendingTransactionResponse({
      poolError: options.poolError ?? "",
      txn: algosdk.decodeSignedTransaction(transaction.signTxn(signer.sk)),
      ...(options.confirmedRound === undefined
        ? {}
        : { confirmedRound: BigInt(options.confirmedRound) }),
    }),
  );
}

async function expectUnavailable(
  promise: Promise<unknown>,
  dependency?: "algod" | "indexer",
): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RailError);
  expect(error).toMatchObject({
    code: "UNAVAILABLE",
    ...(dependency === undefined ? {} : { dependency }),
  });
}

describe("rail-avm direct stake lookups (spec 2026-09-21)", () => {
  it("rail_avm_get_asset_transfer_decodes_both_upstreams", async () => {
    const { config, treasury } = accountConfig();
    const bot = algosdk.generateAccount();
    const note = new TextEncoder().encode("osc:stake:clm_direct");
    const withNote = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: bot.addr,
      receiver: treasury.addr,
      amount: 1_000,
      assetIndex: config.usdcAsaId,
      note,
      suggestedParams: params,
    });
    const withoutNote =
      algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: bot.addr,
        receiver: treasury.addr,
        amount: 999,
        assetIndex: config.usdcAsaId,
        suggestedParams: params,
      });
    const payment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: bot.addr,
      receiver: treasury.addr,
      amount: 5,
      suggestedParams: params,
    });
    const closeTo = algosdk.generateAccount().addr.toString();
    const indexedNote = Buffer.from("osc:stake:clm_indexed", "utf8");
    const responses: Response[] = [
      pendingResponse(withNote, bot, { confirmedRound: 22_000 }),
      pendingResponse(withoutNote, bot, { confirmedRound: 22_001 }),
      pendingResponse(payment, bot, { confirmedRound: 22_002 }),
      pendingResponse(withNote, bot),
      pendingResponse(withNote, bot, { poolError: "overspend" }),
      json({ "last-round": 22_003 }),
      json({}, 404),
      json({
        transaction: {
          id: "INDEXED",
          sender: bot.addr.toString(),
          "tx-type": "axfer",
          "confirmed-round": 22_004,
          note: indexedNote.toString("base64"),
          "asset-transfer-transaction": {
            receiver: treasury.addr.toString(),
            "asset-id": config.usdcAsaId,
            amount: 1_000,
            "close-to": closeTo,
          },
        },
      }),
      json({}, 404),
      json({
        transaction: {
          id: "INDEXED_PAY",
          sender: bot.addr.toString(),
          "tx-type": "pay",
          "confirmed-round": 22_005,
          "payment-transaction": { receiver: treasury.addr.toString() },
        },
      }),
      json({}, 404),
      json({}, 404),
      json({ "last-round": 22_006 }),
    ];
    const urls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      urls.push(input.toString());
      expect(new Headers(init?.headers).get("accept")).toBe(
        input.toString().includes("format=msgpack")
          ? "application/msgpack"
          : "application/json",
      );
      const response = responses.shift();
      if (response === undefined) throw new Error("fixture exhausted");
      return response;
    });
    const rail = createAvmRail(config, { fetch });

    await expect(rail.getAssetTransfer(withNote.txID())).resolves.toEqual({
      status: "confirmed",
      confirmedRound: 22_000,
      transfer: {
        sender: bot.addr.toString(),
        receiver: treasury.addr.toString(),
        asset: String(config.usdcAsaId),
        amount: 1_000,
        closeTo: null,
        note,
      },
    });
    await expect(rail.getAssetTransfer(withoutNote.txID())).resolves.toEqual({
      status: "confirmed",
      confirmedRound: 22_001,
      transfer: {
        sender: bot.addr.toString(),
        receiver: treasury.addr.toString(),
        asset: String(config.usdcAsaId),
        amount: 999,
        closeTo: null,
        note: new Uint8Array(),
      },
    });
    await expect(rail.getAssetTransfer(payment.txID())).resolves.toEqual({
      status: "confirmed",
      confirmedRound: 22_002,
      transfer: null,
    });
    await expect(rail.getAssetTransfer("PENDING")).resolves.toEqual({
      status: "pending",
    });
    await expect(rail.getAssetTransfer("REJECTED")).resolves.toEqual({
      status: "not_found",
      currentRound: 22_003,
    });
    await expect(rail.getAssetTransfer("INDEXED")).resolves.toEqual({
      status: "confirmed",
      confirmedRound: 22_004,
      transfer: {
        sender: bot.addr.toString(),
        receiver: treasury.addr.toString(),
        asset: String(config.usdcAsaId),
        amount: 1_000,
        closeTo,
        note: new Uint8Array(indexedNote),
      },
    });
    await expect(rail.getAssetTransfer("INDEXED_PAY")).resolves.toEqual({
      status: "confirmed",
      confirmedRound: 22_005,
      transfer: null,
    });
    await expect(rail.getAssetTransfer("ABSENT")).resolves.toEqual({
      status: "not_found",
      currentRound: 22_006,
    });
    expect(urls[0]).toBe(
      `${config.algodUrl}/v2/transactions/pending/${withNote.txID()}?format=msgpack`,
    );
    expect(urls[7]).toBe(`${config.indexerUrl}/v2/transactions/INDEXED`);
    expect(urls[12]).toBe(`${config.algodUrl}/v2/status`);
    expect(responses).toHaveLength(0);

    const diagnostics: RailDiagnostic[] = [];
    const malformedRail = createAvmRail(config, {
      fetch: vi.fn(
        async () =>
          new Response(new Uint8Array([0xc1, 0x00]), {
            status: 200,
            headers: { "content-type": "application/msgpack" },
          }),
      ),
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await expectUnavailable(malformedRail.getAssetTransfer("GARBAGE"), "algod");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: "malformed_response",
      status: 200,
    });

    const algodDown = createAvmRail(config, {
      fetch: vi.fn(async () => {
        throw new Error("transport unavailable");
      }),
    });
    await expectUnavailable(algodDown.getAssetTransfer("TX"), "algod");

    const indexerDown = createAvmRail(config, {
      fetch: vi.fn(async (input) => {
        if (input.toString().startsWith(config.indexerUrl)) {
          throw new Error("indexer unavailable");
        }
        return json({}, 404);
      }),
    });
    await expectUnavailable(indexerDown.getAssetTransfer("TX"), "indexer");
  });
});
