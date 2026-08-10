import { RailError } from "@onestepchess/core";
import { paymentRailConformanceRows } from "@onestepchess/rail-mock/conformance";
import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import { createAvmRail } from "./index.js";
import {
  accountConfig,
  CLAIM_URL,
  exactPaymentFixture,
  json,
  MAINNET_CAIP2,
  signedClientTransaction,
  suggestedParams,
  supported,
  TESTNET_CAIP2,
} from "./test-helpers.js";

function fixtureSuggestedParams() {
  return {
    flatFee: true,
    fee: 1_000,
    minFee: 1_000,
    firstValid: 20_000,
    lastValid: 21_000,
    genesisID: "fixture-v1",
    genesisHash: Buffer.from(TESTNET_CAIP2.slice("algorand:".length), "base64"),
  };
}

describe("rail-avm Release 4 prepared treasury and opt-in adapter", () => {
  it("avm_prepares_payout_groups_before_broadcast_with_exact_notes_fees_txids_and_bytes", async () => {
    const { config, treasury } = accountConfig();
    for (const size of [1, 3, 16]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(suggestedParams());
      const rail = createAvmRail(config, { fetch });
      const batch = Array.from({ length: size }, (_, index) => ({
        jobId: `job-${size}-${index}`,
        recipient: algosdk.generateAccount().addr.toString(),
        amountMicroUsdc: index + 1,
      }));
      const prepared = await rail.preparePayouts(batch);
      const expected = batch.map((item, index) =>
        algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: treasury.addr,
          receiver: item.recipient,
          amount: item.amountMicroUsdc,
          assetIndex: config.usdcAsaId,
          note: new TextEncoder().encode(`osc:payout:${item.jobId}`),
          suggestedParams: {
            ...fixtureSuggestedParams(),
            fee: index === 0 ? size * 1_000 : 0,
          },
        }),
      );
      algosdk.assignGroupID(expected);

      expect(prepared).toEqual({
        kind: "payouts",
        payloadB64: Buffer.concat(
          expected.map((transaction) =>
            Buffer.from(transaction.signTxn(treasury.sk)),
          ),
        ).toString("base64"),
        groupId: Buffer.from(expected[0]?.group ?? []).toString("base64"),
        txids: expected.map((transaction, index) => ({
          jobId: batch[index]?.jobId,
          txid: transaction.txID(),
        })),
        lastValidRound: 21_000,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0].toString()).toBe(
        "https://algod.example/v2/transactions/params",
      );
    }

    const recipient = algosdk.generateAccount().addr.toString();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const rail = createAvmRail(config, { fetch });
    const invalidBatches = [
      [],
      Array.from({ length: 17 }, (_, index) => ({
        jobId: `too-many-${index}`,
        recipient,
        amountMicroUsdc: 1,
      })),
      [
        { jobId: "duplicate", recipient, amountMicroUsdc: 1 },
        { jobId: "duplicate", recipient, amountMicroUsdc: 1 },
      ],
      [{ jobId: "zero", recipient, amountMicroUsdc: 0 }],
      [
        {
          jobId: "bad-address",
          recipient: "not-an-address",
          amountMicroUsdc: 1,
        },
      ],
    ];
    for (const batch of invalidBatches) {
      await expect(rail.preparePayouts(batch)).rejects.toMatchObject({
        code: "CONTRACT",
      });
    }
    expect(fetch).not.toHaveBeenCalled();

    for (const response of [
      suggestedParams(TESTNET_CAIP2, {
        genesisHash: MAINNET_CAIP2.slice("algorand:".length),
      }),
      suggestedParams(TESTNET_CAIP2, { round: Number.MAX_SAFE_INTEGER }),
    ]) {
      const guardedRail = createAvmRail(config, {
        fetch: vi.fn(async () => response),
      });
      await expect(
        guardedRail.preparePayouts([
          { jobId: "guarded", recipient, amountMicroUsdc: 1 },
        ]),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
  });

  it("avm_prepares_each_funding_leg_with_a_durable_txid_and_exact_bonus_note", async () => {
    const { config, bonus } = accountConfig();
    const player = algosdk.generateAccount().addr.toString();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => suggestedParams());
    const rail = createAvmRail(config, { fetch });
    const signSpy = vi.spyOn(algosdk.Transaction.prototype, "signTxn");
    try {
      const algo = await rail.prepareFunding({
        player,
        leg: "algo",
        amount: 101_000,
      });
      const usdc = await rail.prepareFunding({
        player,
        leg: "usdc",
        amount: 100_000,
      });
      expect(signSpy).toHaveBeenCalledTimes(2);

      for (const prepared of [algo, usdc]) {
        const signed = algosdk.decodeSignedTransaction(
          Buffer.from(prepared.payloadB64, "base64"),
        );
        expect(prepared).toMatchObject({
          kind: "funding",
          player,
          txid: signed.txn.txID(),
          lastValidRound: 21_000,
        });
        expect(signed.txn.sender.toString()).toBe(bonus.addr.toString());
        expect(signed.txn.fee).toBe(1_000n);
        expect(Buffer.from(signed.txn.note).toString("utf8")).toBe(
          `osc:bonus:${prepared.leg}:${player}`,
        );
        expect(signed.sig).toBeDefined();
      }
      const decodedAlgo = algosdk.decodeSignedTransaction(
        Buffer.from(algo.payloadB64, "base64"),
      ).txn;
      expect(decodedAlgo.payment).toMatchObject({ amount: 101_000n });
      expect(decodedAlgo.payment?.receiver.toString()).toBe(player);
      expect(decodedAlgo.assetTransfer).toBeUndefined();

      const decodedUsdc = algosdk.decodeSignedTransaction(
        Buffer.from(usdc.payloadB64, "base64"),
      ).txn;
      expect(decodedUsdc.assetTransfer).toMatchObject({
        amount: 100_000n,
        assetIndex: BigInt(config.usdcAsaId),
      });
      expect(decodedUsdc.assetTransfer?.receiver.toString()).toBe(player);
      expect(decodedUsdc.payment).toBeUndefined();
    } finally {
      signSpy.mockRestore();
    }
  });

  it("avm_submit_prepared_replays_identical_payout_and_funding_bytes_without_rebuilding", async () => {
    const { config } = accountConfig();
    const player = algosdk.generateAccount().addr.toString();
    const submitted: Buffer[] = [];
    const submitResponses: Array<Response | "timeout"> = [
      json({ txId: "PAYOUT_OK" }),
      json({ txId: "PAYOUT_REPLAY" }),
      json({ txId: "FUNDING_OK" }),
      json({ txId: "FUNDING_REPLAY" }),
      new Response("node rejected", { status: 400 }),
      "timeout",
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v2/transactions/params")) return suggestedParams();
      if (url.endsWith("/v2/transactions") && init?.method === "POST") {
        submitted.push(Buffer.from(init.body as ArrayBuffer));
        const response = submitResponses.shift();
        if (response === "timeout") {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          });
        }
        if (response !== undefined) return response;
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const rail = createAvmRail({ ...config, requestTimeoutMs: 2 }, { fetch });
    const signSpy = vi.spyOn(algosdk.Transaction.prototype, "signTxn");
    try {
      const payout = await rail.preparePayouts([
        { jobId: "prepared", recipient: player, amountMicroUsdc: 7 },
      ]);
      const funding = await rail.prepareFunding({
        player,
        leg: "algo",
        amount: 9,
      });
      expect(signSpy).toHaveBeenCalledTimes(2);

      await expect(rail.submitPrepared(payout)).resolves.toEqual({ ok: true });
      await expect(rail.submitPrepared(payout)).resolves.toEqual({ ok: true });
      await expect(rail.submitPrepared(funding)).resolves.toEqual({ ok: true });
      await expect(rail.submitPrepared(funding)).resolves.toEqual({ ok: true });
      await expect(rail.submitPrepared(payout)).resolves.toEqual({
        ok: false,
        reason: "rejected",
        detail: "node rejected",
      });
      await expect(rail.submitPrepared(funding)).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect(submitted[0]).toEqual(submitted[1]);
      expect(submitted[2]).toEqual(submitted[3]);
      expect(submitted[0]?.toString("base64")).toBe(payout.payloadB64);
      expect(submitted[2]?.toString("base64")).toBe(funding.payloadB64);
      expect(signSpy).toHaveBeenCalledTimes(2);
      expect(
        fetch.mock.calls.filter(([input]) =>
          String(input).endsWith("/v2/transactions/params"),
        ),
      ).toHaveLength(2);

      await expect(
        rail.submitPrepared({ ...funding, payloadB64: "%%%" }),
      ).rejects.toMatchObject({ code: "CONTRACT" });
      await expect(
        rail.submitPrepared({ ...funding, txid: "metadata-mismatch" }),
      ).rejects.toMatchObject({ code: "CONTRACT" });
    } finally {
      signSpy.mockRestore();
    }
  });

  it("avm_funding_note_lookup_returns_the_oldest_confirmed_bonus_account_send", async () => {
    const { config, bonus } = accountConfig();
    const player = algosdk.generateAccount().addr.toString();
    const other = algosdk.generateAccount().addr.toString();
    const expectedNote = Buffer.from(`osc:bonus:usdc:${player}`).toString(
      "base64",
    );
    const responses: Array<Response | "outage"> = [
      json({ transactions: [] }),
      json({
        transactions: [
          {
            id: "WRONG_SENDER",
            sender: other,
            note: expectedNote,
            "confirmed-round": 1,
          },
          {
            id: "WRONG_NOTE",
            sender: bonus.addr.toString(),
            note: Buffer.from("osc:bonus:algo:wrong").toString("base64"),
            "confirmed-round": 2,
          },
          {
            id: "NEWER",
            sender: bonus.addr.toString(),
            note: expectedNote,
            "confirmed-round": 30,
          },
          {
            id: "OLDEST",
            sender: bonus.addr.toString(),
            note: expectedNote,
            "confirmed-round": 20,
          },
        ],
      }),
      json({ transactions: "malformed" }),
      "outage",
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = responses.shift();
      if (response === "outage") throw new Error("indexer unavailable");
      if (response === undefined) throw new Error("fixture exhausted");
      return response;
    });
    const rail = createAvmRail(config, { fetch });

    await expect(rail.findFundingByNote(player, "usdc")).resolves.toBeNull();
    await expect(rail.findFundingByNote(player, "usdc")).resolves.toEqual({
      txid: "OLDEST",
      confirmedRound: 20,
    });
    const requested = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(requested.searchParams.get("address")).toBe(bonus.addr.toString());
    expect(requested.searchParams.get("address-role")).toBe("sender");
    expect(requested.searchParams.get("note-prefix")).toBe(expectedNote);
    await expect(rail.findFundingByNote(player, "usdc")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(rail.findFundingByNote(player, "usdc")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("avm_builds_only_the_pinned_unsigned_usdc_optin_transaction", async () => {
    const { config } = accountConfig();
    const player = algosdk.generateAccount().addr.toString();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(suggestedParams());
    const signSpy = vi.spyOn(algosdk.Transaction.prototype, "signTxn");
    try {
      const rail = createAvmRail(config, { fetch });
      const encoded = await rail.buildOptInTxn(player);
      const transaction = algosdk.decodeUnsignedTransaction(
        Buffer.from(encoded, "base64"),
      );
      expect(transaction.sender.toString()).toBe(player);
      expect(transaction.assetTransfer?.receiver.toString()).toBe(player);
      expect(transaction.assetTransfer).toMatchObject({
        amount: 0n,
        assetIndex: BigInt(config.usdcAsaId),
      });
      expect(transaction.fee).toBe(1_000n);
      expect(transaction.firstValid).toBe(20_000n);
      expect(transaction.lastValid).toBe(21_000n);
      expect(
        Buffer.from(transaction.genesisHash ?? []).toString("base64"),
      ).toBe(TESTNET_CAIP2.slice("algorand:".length));
      expect(transaction.group).toBeUndefined();
      expect(transaction.lease).toBeUndefined();
      expect(transaction.note).toHaveLength(0);
      expect(transaction.rekeyTo).toBeUndefined();
      expect(transaction.assetTransfer?.closeRemainderTo).toBeUndefined();
      expect(transaction.payment).toBeUndefined();
      expect(signSpy).not.toHaveBeenCalled();

      const wrongNetwork = createAvmRail(config, {
        fetch: vi.fn(async () =>
          suggestedParams(TESTNET_CAIP2, {
            genesisHash: MAINNET_CAIP2.slice("algorand:".length),
          }),
        ),
      });
      await expect(wrongNetwork.buildOptInTxn(player)).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      const unsafe = createAvmRail(config, {
        fetch: vi.fn(async () =>
          suggestedParams(TESTNET_CAIP2, { round: Number.MAX_SAFE_INTEGER }),
        ),
      });
      await expect(unsafe.buildOptInTxn(player)).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      expect(signSpy).not.toHaveBeenCalled();
    } finally {
      signSpy.mockRestore();
    }
  });

  it("avm_relays_client_signed_optin_bytes_without_using_the_treasury_key", async () => {
    const { config } = accountConfig();
    const player = algosdk.generateAccount();
    const signed = signedClientTransaction(player);
    const bodies: Buffer[] = [];
    let call = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      bodies.push(Buffer.from(init?.body as ArrayBuffer));
      call += 1;
      if (call === 1) return json({ txId: "CLIENT_OPTIN_TXID" });
      if (call === 2) return new Response("node rejected", { status: 400 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    });
    const rail = createAvmRail({ ...config, requestTimeoutMs: 2 }, { fetch });
    const signSpy = vi.spyOn(algosdk.Transaction.prototype, "signTxn");
    try {
      await expect(rail.submitSignedTransaction(signed)).resolves.toEqual({
        ok: true,
        txid: "CLIENT_OPTIN_TXID",
      });
      await expect(rail.submitSignedTransaction(signed)).resolves.toEqual({
        ok: false,
        reason: "rejected",
        detail: "node rejected",
      });
      await expect(rail.submitSignedTransaction(signed)).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect(bodies).toHaveLength(3);
      expect(bodies.every((body) => body.toString("base64") === signed)).toBe(
        true,
      );
      expect(signSpy).not.toHaveBeenCalled();
      await expect(
        rail.submitSignedTransaction("%%% malformed"),
      ).rejects.toEqual(expect.objectContaining({ code: "CONTRACT" }));
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      signSpy.mockRestore();
    }
  });

  it("rail_avm_satisfies_the_complete_payment_rail_contract", async () => {
    const { config, treasury } = accountConfig();
    const payer = algosdk.generateAccount();
    const feePayer = algosdk.generateAccount().addr.toString();
    const recipients = Array.from({ length: 3 }, () =>
      algosdk.generateAccount().addr.toString(),
    );

    for (const row of paymentRailConformanceRows) {
      const submissions: Buffer[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/supported")) {
          return supported(TESTNET_CAIP2, feePayer);
        }
        if (url.endsWith("/v2/transactions/params")) return suggestedParams();
        if (url.includes("/v2/accounts/")) {
          return json({
            amount: 10_000_000,
            "min-balance": 100_000,
            assets: [],
          });
        }
        if (url.endsWith("/v2/transactions") && init?.method === "POST") {
          submissions.push(Buffer.from(init.body as ArrayBuffer));
          return json({ txId: "accepted" });
        }
        throw new Error(`unexpected conformance URL ${url}`);
      });
      const rail = createAvmRail(config, { fetch });
      await rail.health();
      await row.run(() => ({
        rail,
        payoutRecipient: (index) => recipients[index % recipients.length] ?? "",
        buildHeader: (challenge) =>
          exactPaymentFixture({
            payer,
            feePayer,
            treasury: treasury.addr.toString(),
            caip2: challenge.required.accepts[0].network,
            asaId: Number(challenge.required.accepts[0].asset),
            amount: Number(challenge.required.accepts[0].amount),
            resource: challenge.required.resource.url,
          }).header,
        assertPreparedReplay: async (prepared) => {
          expect(submissions.at(-2)).toEqual(submissions.at(-1));
          expect(submissions.at(-1)?.toString("base64")).toBe(
            prepared.payloadB64,
          );
        },
      }));
    }

    const verifyResponses = [
      json({ isValid: true }),
      json({ isValid: false, invalidReason: "overspend" }, 400),
      json({ isValid: false, invalidReason: "asset not opted in" }, 400),
      json({ isValid: false, invalidReason: "invalid signature" }, 400),
      json({}, 503),
    ];
    const settleResponses = [
      json({
        success: true,
        transaction: "SETTLED",
        network: TESTNET_CAIP2,
      }),
      json({ success: false, errorReason: "rejected" }, 400),
      json({ success: false, errorReason: "txn dead" }, 400),
      json({}, 503),
    ];
    const preparedSubmitResponses = [
      json({ txId: "OK" }),
      new Response("rejected", { status: 400 }),
      json({}, 503),
    ];
    const signedSubmitResponses = [
      json({ txId: "SIGNED_OK" }),
      new Response("rejected", { status: 400 }),
      json({}, 503),
    ];
    let submissionKind: "prepared" | "signed" = "prepared";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/supported")) {
        return supported(TESTNET_CAIP2, feePayer);
      }
      if (url.pathname.endsWith("/verify")) {
        return verifyResponses.shift() ?? json({}, 503);
      }
      if (url.pathname.endsWith("/settle")) {
        return settleResponses.shift() ?? json({}, 503);
      }
      if (url.pathname.endsWith("/v2/transactions/params")) {
        return suggestedParams();
      }
      if (url.pathname.includes("/v2/transactions/pending/CONFIRMED")) {
        return json({ "confirmed-round": 30 });
      }
      if (url.pathname.includes("/v2/transactions/pending/PENDING")) {
        return json({ "confirmed-round": 0 });
      }
      if (url.pathname.includes("/v2/transactions/pending/MISSING")) {
        return json({}, 404);
      }
      if (url.pathname.endsWith("/v2/transactions/MISSING")) {
        return json({}, 404);
      }
      if (url.pathname.endsWith("/v2/status")) {
        return json({ "last-round": 31 });
      }
      if (
        url.pathname.endsWith("/v2/transactions") &&
        init?.method !== "POST"
      ) {
        const note = url.searchParams.get("note-prefix") ?? "";
        return json({
          transactions: [
            {
              id: "NOTE_TX",
              sender: url.searchParams.get("address") ?? "",
              note,
              "confirmed-round": 32,
            },
          ],
        });
      }
      if (url.pathname.includes("/v2/accounts/")) {
        return json({
          amount: 500_000,
          "min-balance": 100_000,
          assets: [{ "asset-id": config.usdcAsaId, amount: 123 }],
        });
      }
      if (
        url.pathname.endsWith("/v2/transactions") &&
        init?.method === "POST"
      ) {
        return submissionKind === "prepared"
          ? (preparedSubmitResponses.shift() ?? json({}, 503))
          : (signedSubmitResponses.shift() ?? json({}, 503));
      }
      throw new Error(`unexpected contract URL ${url.toString()}`);
    });
    const rail = createAvmRail(config, { fetch });
    expect(await rail.health()).toBe(true);
    const challenge = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: CLAIM_URL,
    });
    const payment = exactPaymentFixture({
      payer,
      feePayer,
      treasury: treasury.addr.toString(),
    });
    expect(rail.decodePayment(payment.header)).toMatchObject({ ok: true });
    expect(rail.decodePayment("malformed")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      await Promise.all(
        Array.from({ length: 5 }, () =>
          rail.verify(payment.header, challenge.required),
        ),
      ),
    ).toEqual([
      { ok: true },
      { ok: false, reason: "insufficient_funds", detail: "overspend" },
      { ok: false, reason: "not_opted_in", detail: "asset not opted in" },
      { ok: false, reason: "invalid_payment", detail: "invalid signature" },
      { ok: false, reason: "unavailable" },
    ]);
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          rail.settle(payment.header, challenge.required),
        ),
      ),
    ).toEqual([
      expect.objectContaining({ ok: true, txid: "SETTLED" }),
      { ok: false, reason: "rejected", detail: "rejected" },
      { ok: false, reason: "expired", detail: "txn dead" },
      { ok: false, reason: "unavailable" },
    ]);
    expect(
      Buffer.from(rail.encodePaymentResponse("TX"), "base64").toString(),
    ).toBe(
      JSON.stringify({
        success: true,
        transaction: "TX",
        network: TESTNET_CAIP2,
      }),
    );

    const payout = await rail.preparePayouts([
      { jobId: "contract", recipient: recipients[0] ?? "", amountMicroUsdc: 1 },
    ]);
    const funding = await rail.prepareFunding({
      player: recipients[0] ?? "",
      leg: "usdc",
      amount: 1,
    });
    expect(
      await Promise.all([
        rail.submitPrepared(payout),
        rail.submitPrepared(funding),
        rail.submitPrepared(payout),
      ]),
    ).toEqual([
      { ok: true },
      { ok: false, reason: "rejected", detail: "rejected" },
      { ok: false, reason: "unavailable" },
    ]);
    expect(await rail.getTransactionStatus("CONFIRMED")).toEqual({
      status: "confirmed",
      confirmedRound: 30,
    });
    expect(await rail.getTransactionStatus("PENDING")).toEqual({
      status: "pending",
    });
    expect(await rail.getTransactionStatus("MISSING")).toEqual({
      status: "not_found",
      currentRound: 31,
    });
    expect(await rail.findPayoutByNote("contract")).toEqual({
      txid: "NOTE_TX",
      confirmedRound: 32,
    });
    expect(await rail.findFundingByNote(recipients[0] ?? "", "usdc")).toEqual({
      txid: "NOTE_TX",
      confirmedRound: 32,
    });
    expect(await rail.getBalances(recipients[0] ?? "")).toEqual({
      usdcMicroUsdc: 123,
      algoMicroAlgo: 500_000,
    });
    expect(await rail.getAccountInfo(recipients[0] ?? "")).toEqual({
      exists: true,
      rekeyed: false,
      optedInUsdc: true,
      spendableAlgoMicro: 400_000,
    });
    expect(await rail.buildOptInTxn(recipients[0] ?? "")).toEqual(
      expect.any(String),
    );

    submissionKind = "signed";
    const signed = signedClientTransaction(payer);
    expect(
      await Promise.all([
        rail.submitSignedTransaction(signed),
        rail.submitSignedTransaction(signed),
        rail.submitSignedTransaction(signed),
      ]),
    ).toEqual([
      { ok: true, txid: "SIGNED_OK" },
      { ok: false, reason: "rejected", detail: "rejected" },
      { ok: false, reason: "unavailable" },
    ]);
    expect(Object.keys(rail).sort()).toEqual(
      [
        "treasuryAddress",
        "bonusAddress",
        "buildPaymentChallenge",
        "decodePayment",
        "verify",
        "settle",
        "encodePaymentResponse",
        "preparePayouts",
        "prepareFunding",
        "submitPrepared",
        "getTransactionStatus",
        "findPayoutByNote",
        "findFundingByNote",
        "buildOptInTxn",
        "submitSignedTransaction",
        "getBalances",
        "getAccountInfo",
        "health",
      ].sort(),
    );
    await expect(
      rail.preparePayouts(
        Array.from({ length: 17 }, (_, index) => ({
          jobId: `contract-${index}`,
          recipient: recipients[0] ?? "",
          amountMicroUsdc: 1,
        })),
      ),
    ).rejects.toBeInstanceOf(RailError);
  });
});
