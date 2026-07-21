import type { RailError } from "@onestepchess/core";
import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import {
  type AvmRailConfig,
  createAvmRail,
  mapSettleFailure,
  mapVerifyFailure,
} from "./index.js";

const TESTNET_CAIP2 = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const CLAIM_URL = "https://osc.example/api/v1/claims/clm_t1/move";

function accountConfig(caip2 = TESTNET_CAIP2) {
  const treasury = algosdk.generateAccount();
  const config: AvmRailConfig = {
    caip2,
    usdcAsaId: caip2 === TESTNET_CAIP2 ? 10_458_941 : 31_566_704,
    algodUrl: "https://algod.example",
    indexerUrl: "https://indexer.example",
    facilitatorUrl: "https://facilitator.example",
    treasuryMnemonic: algosdk.secretKeyToMnemonic(treasury.sk),
    requestTimeoutMs: 50,
  };
  return { config, treasury };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function supported(caip2: string, feePayer: string): Response {
  return json({
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: caip2,
        extra: { feePayer },
      },
    ],
    extensions: [],
    signers: { [caip2]: [feePayer] },
  });
}

function suggestedParams(caip2 = TESTNET_CAIP2): Response {
  return json({
    fee: 1,
    "min-fee": 1_000,
    "last-round": 20_000,
    "genesis-id": "fixture-v1",
    "genesis-hash": caip2.slice("algorand:".length),
    "consensus-version": "fixture",
  });
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function exactHeader(args: {
  payer: algosdk.Account;
  feePayer: string;
  treasury: string;
  caip2?: string;
  asaId?: number;
  amount?: number;
}): string {
  const caip2 = args.caip2 ?? TESTNET_CAIP2;
  const asaId = args.asaId ?? 10_458_941;
  const amount = args.amount ?? 1_000;
  const params = {
    flatFee: true,
    fee: 0,
    minFee: 1_000,
    firstValid: 20_000,
    lastValid: 21_000,
    genesisID: "fixture-v1",
    genesisHash: Buffer.from(caip2.slice("algorand:".length), "base64"),
  };
  const feeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: args.feePayer,
    receiver: args.feePayer,
    amount: 0,
    suggestedParams: { ...params, fee: 2_000 },
  });
  const paymentTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: args.payer.addr,
    receiver: args.treasury,
    amount,
    assetIndex: asaId,
    suggestedParams: params,
  });
  algosdk.assignGroupID([feeTxn, paymentTxn]);
  const accepted = {
    scheme: "exact",
    network: caip2,
    asset: String(asaId),
    amount: String(amount),
    payTo: args.treasury,
    maxTimeoutSeconds: 120,
    extra: { feePayer: args.feePayer, decimals: 6 },
  };
  return encode({
    x402Version: 2,
    resource: { url: CLAIM_URL },
    accepted,
    payload: {
      paymentGroup: [
        Buffer.from(algosdk.encodeUnsignedTransaction(feeTxn)).toString(
          "base64",
        ),
        Buffer.from(paymentTxn.signTxn(args.payer.sk)).toString("base64"),
      ],
      paymentIndex: 1,
    },
  });
}

describe("rail-avm T1", () => {
  it("avm_health_requires_configured_network_and_caches_fee_payer", async () => {
    for (const caip2 of [TESTNET_CAIP2, MAINNET_CAIP2]) {
      const { config } = accountConfig(caip2);
      const feePayer = algosdk.generateAccount().addr.toString();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(supported(caip2, feePayer))
        .mockResolvedValueOnce(
          json({ kinds: [], signers: { [caip2]: [feePayer] } }),
        );
      const rail = createAvmRail(config, { fetch });

      expect(() =>
        rail.buildPaymentChallenge({
          amountMicroUsdc: 1_000,
          resource: CLAIM_URL,
        }),
      ).toThrowError(expect.objectContaining({ code: "NOT_READY" }));
      await expect(rail.health()).resolves.toBe(true);
      const first = rail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: CLAIM_URL,
      });
      expect(first.required.accepts[0]).toMatchObject({
        scheme: "exact",
        network: caip2,
        extra: { feePayer, decimals: 6 },
      });
      await expect(rail.health()).resolves.toBe(false);
      expect(
        rail.buildPaymentChallenge({
          amountMicroUsdc: 1_000,
          resource: CLAIM_URL,
        }),
      ).toEqual(first);
    }
  });

  it("avm_challenge_and_decode_match_v2_golden_fixtures", async () => {
    const { config, treasury } = accountConfig();
    const payer = algosdk.generateAccount();
    const feePayer = algosdk.generateAccount().addr.toString();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(supported(TESTNET_CAIP2, feePayer));
    const rail = createAvmRail(config, { fetch });
    await rail.health();

    const challenge = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: CLAIM_URL,
    });
    expect(
      JSON.parse(Buffer.from(challenge.header, "base64").toString()),
    ).toEqual(challenge.required);
    expect(challenge.required).toEqual({
      x402Version: 2,
      resource: { url: CLAIM_URL },
      accepts: [
        {
          scheme: "exact",
          network: TESTNET_CAIP2,
          asset: "10458941",
          amount: "1000",
          payTo: treasury.addr.toString(),
          maxTimeoutSeconds: 120,
          extra: { feePayer, decimals: 6 },
        },
      ],
    });

    const header = exactHeader({
      payer,
      feePayer,
      treasury: treasury.addr.toString(),
    });
    const decoded = rail.decodePayment(header);
    expect(decoded).toEqual({
      ok: true,
      payment: {
        clientTxId: expect.any(String),
        sender: payer.addr.toString(),
        amountMicroUsdc: 1_000,
        asset: "10458941",
        payTo: treasury.addr.toString(),
        lastValidRound: 21_000,
      },
    });
    if (!decoded.ok) throw new Error("fixture did not decode");
    const paymentGroup = JSON.parse(Buffer.from(header, "base64").toString())
      .payload.paymentGroup as string[];
    const signed = algosdk.decodeSignedTransaction(
      Buffer.from(paymentGroup[1] ?? "", "base64"),
    );
    expect(decoded.payment.clientTxId).toBe(signed.txn.txID());

    for (const malformed of [
      "%%%",
      encode({}),
      encode({
        x402Version: 2,
        resource: { url: CLAIM_URL },
        accepted: challenge.required.accepts[0],
        payload: { paymentGroup: [], paymentIndex: 0 },
      }),
      encode({
        x402Version: 2,
        resource: { url: CLAIM_URL },
        accepted: challenge.required.accepts[0],
        payload: { paymentGroup: ["bm90LW1zZ3BhY2s="], paymentIndex: 0 },
      }),
    ]) {
      expect(rail.decodePayment(malformed)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("avm_verify_and_settle_are_single_attempt_and_taxonomy_locked", async () => {
    const { config, treasury } = accountConfig();
    const payer = algosdk.generateAccount();
    const feePayer = algosdk.generateAccount().addr.toString();
    const header = exactHeader({
      payer,
      feePayer,
      treasury: treasury.addr.toString(),
    });
    const responses = [
      json({ isValid: true }),
      json({ isValid: false, invalidReason: "overspend" }),
      json({ isValid: false, invalidReason: "asset not opted in" }),
      json({ isValid: false, invalidReason: "new upstream reason" }),
      json({ success: true, transaction: "SETTLE_TX", network: TESTNET_CAIP2 }),
      json(
        {
          success: false,
          errorReason: "transaction expired",
          transaction: "",
          network: TESTNET_CAIP2,
        },
        400,
      ),
      json(
        {
          success: false,
          errorReason: "rejected by node",
          transaction: "",
          network: TESTNET_CAIP2,
        },
        400,
      ),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("network down");
      return response;
    });
    const rail = createAvmRail(config, { fetch });
    const required = {
      x402Version: 2 as const,
      resource: { url: CLAIM_URL },
      accepts: [
        {
          scheme: "exact",
          network: TESTNET_CAIP2,
          asset: "10458941",
          amount: "1000",
          payTo: treasury.addr.toString(),
          maxTimeoutSeconds: 120,
          extra: { feePayer, decimals: 6 },
        },
      ] as const,
    };

    await expect(rail.verify(header, required)).resolves.toEqual({ ok: true });
    await expect(rail.verify(header, required)).resolves.toMatchObject({
      ok: false,
      reason: "insufficient_funds",
    });
    await expect(rail.verify(header, required)).resolves.toMatchObject({
      ok: false,
      reason: "not_opted_in",
    });
    await expect(rail.verify(header, required)).resolves.toEqual({
      ok: false,
      reason: "invalid_payment",
      detail: "new upstream reason",
    });
    await expect(rail.settle(header, required)).resolves.toEqual({
      ok: true,
      txid: "SETTLE_TX",
      confirmedRound: null,
      paymentResponseHeader: encode({
        success: true,
        transaction: "SETTLE_TX",
        network: TESTNET_CAIP2,
      }),
    });
    await expect(rail.settle(header, required)).resolves.toMatchObject({
      ok: false,
      reason: "expired",
    });
    await expect(rail.settle(header, required)).resolves.toMatchObject({
      ok: false,
      reason: "rejected",
    });
    await expect(rail.verify(header, required)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(8);

    const before = fetch.mock.calls.length;
    await expect(rail.verify("malformed", required)).resolves.toEqual({
      ok: false,
      reason: "invalid_payment",
    });
    expect(fetch).toHaveBeenCalledTimes(before);
    expect(mapVerifyFailure("overspend")).toBe("insufficient_funds");
    expect(mapVerifyFailure("account not opted into asset")).toBe(
      "not_opted_in",
    );
    expect(mapVerifyFailure("unknown")).toBe("invalid_payment");
    expect(mapSettleFailure("txn validity expired")).toBe("expired");
    expect(mapSettleFailure("rejected by node")).toBe("rejected");

    const timeoutFetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const timedRail = createAvmRail(
      { ...config, requestTimeoutMs: 1 },
      { fetch: timeoutFetch },
    );
    await expect(timedRail.verify(header, required)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);
  });

  it("avm_prepared_payout_is_persistable_before_exact_submission", async () => {
    const { config, treasury } = accountConfig();
    const recipients = Array.from({ length: 3 }, () =>
      algosdk.generateAccount().addr.toString(),
    );
    const submitted: Uint8Array[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v2/transactions/params")) return suggestedParams();
      if (url.endsWith("/v2/transactions") && init?.method === "POST") {
        submitted.push(new Uint8Array(init.body as ArrayBuffer));
        return json({ txId: "accepted" });
      }
      throw new Error(`unexpected fixture URL: ${url}`);
    });
    const rail = createAvmRail(config, { fetch });
    const batch = recipients.map((recipient, index) => ({
      jobId: `job-${index + 1}`,
      recipient,
      amountMicroUsdc: index + 1,
    }));

    const prepared = await rail.preparePayouts(batch);
    expect(prepared).toMatchObject({
      kind: "payouts",
      payloadB64: expect.any(String),
      groupId: expect.any(String),
      lastValidRound: 21_000,
      txids: batch.map(({ jobId }) => ({ jobId, txid: expect.any(String) })),
    });
    expect(submitted).toHaveLength(0);
    expect(new Set(prepared.txids.map(({ txid }) => txid)).size).toBe(3);

    await expect(rail.submitPrepared(prepared)).resolves.toEqual({ ok: true });
    await expect(rail.submitPrepared(prepared)).resolves.toEqual({ ok: true });
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toEqual(submitted[1]);
    expect(Buffer.from(submitted[0] ?? []).toString("base64")).toBe(
      prepared.payloadB64,
    );

    const expectedTxns = batch.map((item, index) =>
      algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: treasury.addr,
        receiver: item.recipient,
        amount: item.amountMicroUsdc,
        assetIndex: config.usdcAsaId,
        note: new TextEncoder().encode(`osc:payout:${item.jobId}`),
        suggestedParams: {
          flatFee: true,
          fee: index === 0 ? 3_000 : 0,
          minFee: 1_000,
          firstValid: 20_000,
          lastValid: 21_000,
          genesisID: "fixture-v1",
          genesisHash: Buffer.from(TESTNET_CAIP2.slice(9), "base64"),
        },
      }),
    );
    algosdk.assignGroupID(expectedTxns);
    expect(
      Buffer.concat(
        expectedTxns.map((txn) => Buffer.from(txn.signTxn(treasury.sk))),
      ).toString("base64"),
    ).toBe(prepared.payloadB64);

    await expect(rail.preparePayouts([])).rejects.toMatchObject({
      code: "CONTRACT",
    });
    await expect(
      rail.preparePayouts(
        Array.from({ length: 17 }, (_, index) => ({
          jobId: `too-many-${index}`,
          recipient: recipients[0] ?? "",
          amountMicroUsdc: 1,
        })),
      ),
    ).rejects.toMatchObject({ code: "CONTRACT" });
  });

  it("avm_transaction_and_note_queries_cover_recovery_variants", async () => {
    const { config, treasury } = accountConfig();
    const note = Buffer.from("osc:payout:job-query").toString("base64");
    const responses = [
      json({ "confirmed-round": 0, "pool-error": "" }),
      json({}, 404),
      json({ transaction: { id: "CONFIRMED", "confirmed-round": 22_001 } }),
      json({}, 404),
      json({}, 404),
      json({ "last-round": 22_002 }),
      json({
        transactions: [
          { id: "NEWER", note, "confirmed-round": 22_010 },
          { id: "OLDEST", note, "confirmed-round": 22_003 },
        ],
      }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("fixture exhausted");
      return response;
    });
    const rail = createAvmRail(config, { fetch });

    await expect(rail.getTransactionStatus("PENDING")).resolves.toEqual({
      status: "pending",
    });
    await expect(rail.getTransactionStatus("CONFIRMED")).resolves.toEqual({
      status: "confirmed",
      confirmedRound: 22_001,
    });
    await expect(rail.getTransactionStatus("ABSENT")).resolves.toEqual({
      status: "not_found",
      currentRound: 22_002,
    });
    await expect(rail.findPayoutByNote("job-query")).resolves.toEqual({
      txid: "OLDEST",
      confirmedRound: 22_003,
    });
    expect(fetch.mock.calls.at(-1)?.[0].toString()).toContain(
      `address=${treasury.addr.toString()}`,
    );

    const unavailable = createAvmRail(config, {
      fetch: vi.fn(async () => {
        throw new Error("indexer offline");
      }),
    });
    await expect(unavailable.getTransactionStatus("TX")).rejects.toEqual(
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });

  it("avm_objects_and_errors_never_expose_treasury_mnemonic", async () => {
    const { config } = accountConfig();
    const secret = config.treasuryMnemonic;
    let calls = 0;
    const rail = createAvmRail(config, {
      fetch: vi.fn(async () => {
        calls += 1;
        if (calls === 2) return new Response(secret, { status: 400 });
        throw new Error(secret);
      }),
    });
    const values: unknown[] = [rail, await rail.health()];
    try {
      await rail.getTransactionStatus("TX");
    } catch (error) {
      values.push(error);
    }
    values.push(
      await rail.submitPrepared({
        kind: "payouts",
        payloadB64: "AA==",
        groupId: "fixture",
        txids: [],
        lastValidRound: 1,
      }),
    );
    const walk = (value: unknown, seen = new Set<unknown>()): void => {
      if (typeof value === "string") expect(value).not.toContain(secret);
      if (
        (typeof value !== "object" && typeof value !== "function") ||
        value === null ||
        seen.has(value)
      )
        return;
      seen.add(value);
      for (const key of Object.keys(value))
        walk((value as Record<string, unknown>)[key], seen);
    };
    for (const value of values) walk(value);
    expect(JSON.stringify(values)).not.toContain(secret);

    expect(() =>
      createAvmRail({ ...config, treasuryMnemonic: "not a mnemonic" }),
    ).toThrowError(
      expect.objectContaining<Partial<RailError>>({ code: "CONTRACT" }),
    );
  });
});
