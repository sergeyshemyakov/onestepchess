import {
  MOVE_RESOURCE_DESCRIPTION,
  MOVE_RESOURCE_MIME_TYPE,
  moveBazaarExtensions,
  type RailError,
  X402_GLOBAL_CHALLENGE_TAG,
} from "@onestepchess/core";
import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import { createAvmRail } from "./index.js";
import {
  accountConfig,
  encodeJson,
  exactPaymentFixture,
  json,
  MAINNET_CAIP2,
  MOVE_URL,
  signedClientTransaction,
  suggestedParams,
  supported,
  TESTNET_CAIP2,
} from "./test-helpers.js";

function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => {
      throw new Error("expected UNAVAILABLE");
    },
    (error: unknown) => {
      expect(error).toMatchObject({ code: "UNAVAILABLE" });
    },
  );
}

describe("rail-avm Release 4 inbound and query adapter", () => {
  it("avm_health_accepts_only_the_configured_exact_network_and_preserves_the_last_good_fee_payer", async () => {
    const { config } = accountConfig();
    const firstSigner = algosdk.generateAccount().addr.toString();
    const rotatedSigner = algosdk.generateAccount().addr.toString();
    let call = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      call += 1;
      if (call === 1) return supported(TESTNET_CAIP2, firstSigner);
      if (call === 2) return supported(TESTNET_CAIP2, rotatedSigner);
      if (call === 3) return new Response("{malformed", { status: 200 });
      if (call === 4) {
        return supported(TESTNET_CAIP2, rotatedSigner, {
          network: MAINNET_CAIP2,
        });
      }
      if (call === 5) {
        return supported(TESTNET_CAIP2, rotatedSigner, {
          signer: firstSigner,
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    });
    const rail = createAvmRail({ ...config, requestTimeoutMs: 2 }, { fetch });

    expect(() =>
      rail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: MOVE_URL,
      }),
    ).toThrowError(expect.objectContaining({ code: "NOT_READY" }));

    await expect(rail.health()).resolves.toBe(true);
    expect(
      rail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: MOVE_URL,
      }).required.accepts[0].extra.feePayer,
    ).toBe(firstSigner);

    await expect(rail.health()).resolves.toBe(true);
    const rotated = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: MOVE_URL,
    });
    expect(rotated.required.accepts[0].extra.feePayer).toBe(rotatedSigner);

    await expect(rail.health()).resolves.toBe(false);
    await expect(rail.health()).resolves.toBe(false);
    await expect(rail.health()).resolves.toBe(false);
    await expect(rail.health()).resolves.toBe(false);
    expect(
      rail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: MOVE_URL,
      }),
    ).toEqual(rotated);
  });

  it("challenge_identity_wire_tag_survives_payment_required_and_payment_signature", async () => {
    const { config, treasury } = accountConfig();
    const payer = algosdk.generateAccount();
    const feePayer = algosdk.generateAccount().addr.toString();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/supported")) {
        return supported(TESTNET_CAIP2, feePayer);
      }
      if (url.endsWith("/verify")) return json({ isValid: true });
      if (url.endsWith("/settle")) {
        return json({
          success: true,
          transaction: "SETTLED_TXID",
          network: TESTNET_CAIP2,
          confirmedRound: 22_001,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const rail = createAvmRail(config, { fetch });
    await expect(rail.health()).resolves.toBe(true);
    const challenge = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: MOVE_URL,
    });

    expect(
      JSON.parse(Buffer.from(challenge.header, "base64").toString("utf8")),
    ).toEqual(challenge.required);
    expect(
      JSON.parse(Buffer.from(challenge.header, "base64").toString("utf8"))
        .accepts[0].extra.tag,
    ).toBe(X402_GLOBAL_CHALLENGE_TAG);
    expect(challenge.required).toEqual({
      x402Version: 2,
      resource: {
        url: MOVE_URL,
        description: MOVE_RESOURCE_DESCRIPTION,
        mimeType: MOVE_RESOURCE_MIME_TYPE,
      },
      accepts: [
        {
          scheme: "exact",
          network: TESTNET_CAIP2,
          asset: "10458941",
          amount: "1000",
          payTo: treasury.addr.toString(),
          maxTimeoutSeconds: 120,
          extra: {
            feePayer,
            decimals: 6,
            tag: X402_GLOBAL_CHALLENGE_TAG,
          },
        },
      ],
      extensions: moveBazaarExtensions(),
    });

    const payment = exactPaymentFixture({
      payer,
      feePayer,
      treasury: treasury.addr.toString(),
    });
    const decoded = rail.decodePayment(payment.header);
    expect(
      JSON.parse(Buffer.from(payment.header, "base64").toString("utf8"))
        .accepted.extra.tag,
    ).toBe(X402_GLOBAL_CHALLENGE_TAG);
    expect(payment.payload.extensions).toEqual(challenge.required.extensions);
    expect(decoded).toEqual({
      ok: true,
      payment: {
        clientTxId: payment.paymentTransaction.txID(),
        sender: payer.addr.toString(),
        amountMicroUsdc: 1_000,
        asset: "10458941",
        payTo: treasury.addr.toString(),
        lastValidRound: 21_000,
      },
    });
    await expect(
      rail.verify(payment.header, challenge.required),
    ).resolves.toEqual({ ok: true });
    await expect(
      rail.settle(payment.header, challenge.required),
    ).resolves.toEqual({
      ok: true,
      txid: "SETTLED_TXID",
      confirmedRound: 22_001,
      paymentResponseHeader: encodeJson({
        success: true,
        transaction: "SETTLED_TXID",
        network: TESTNET_CAIP2,
      }),
    });
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/supported",
      "/verify",
      "/settle",
    ]);
    for (const call of calls.slice(1)) {
      const body = JSON.parse(String(call.init?.body));
      expect(body).toEqual({
        x402Version: 2,
        paymentPayload: payment.payload,
        paymentRequirements: challenge.required.accepts[0],
      });
      expect(body.paymentPayload.extensions).toEqual(
        challenge.required.extensions,
      );
    }
  });

  it("avm_facilitator_taxonomy_is_fixture_locked_and_unknown_reasons_fail_safely", async () => {
    const { config, treasury } = accountConfig();
    const payer = algosdk.generateAccount();
    const feePayer = algosdk.generateAccount().addr.toString();
    const invalidPaymentReasons = [
      "Invalid payload format",
      "Transaction group exceeds maximum size",
      "Payment index out of bounds",
      "Invalid transaction encoding: fixture",
      "Transactions have inconsistent group IDs",
      "Payment transaction is not an asset transfer",
      "Payment amount does not match requirements: fixture",
      "Payment receiver does not match payTo address: fixture",
      "Payment asset does not match requirements: fixture",
      "Fee payer transaction has invalid parameters: fixture",
      "Fee payer transaction fee exceeds maximum: fixture",
      "Payment transaction is not signed",
      "Payment transaction signature does not match sender",
      "Facilitator signer cannot be the payment sender",
      "Transaction genesis hash does not match expected network",
      "Unsigned transaction from non-facilitator address: fixture",
      "Rekey transactions are not allowed",
      "Close-to transactions are not allowed",
      "Key registration transactions are not allowed",
    ];
    const verifyCases = [
      ...invalidPaymentReasons.map((reason) => ({
        reason,
        expected: "invalid_payment" as const,
      })),
      {
        reason: "Transaction simulation failed: overspend",
        expected: "insufficient_funds" as const,
      },
      {
        reason: "Transaction simulation failed: asset not opted in",
        expected: "not_opted_in" as const,
      },
      {
        reason: "captured-upstream-future-reason",
        expected: "invalid_payment" as const,
      },
    ];
    const responses: Response[] = [
      ...verifyCases.map(({ reason }) =>
        json({ isValid: false, invalidReason: reason }, 400),
      ),
      json(
        {
          success: false,
          transaction: "",
          network: TESTNET_CAIP2,
          errorReason: "txn dead: round beyond last valid",
        },
        400,
      ),
      json(
        {
          success: false,
          transaction: "",
          network: TESTNET_CAIP2,
          errorReason: "Failed to submit transaction: rejected by node",
        },
        400,
      ),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith("/supported")) {
        return supported(TESTNET_CAIP2, feePayer);
      }
      const response = responses.shift();
      if (response === undefined) throw new Error("fixture exhausted");
      return response;
    });
    const rail = createAvmRail(config, { fetch });
    await rail.health();
    const required = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: MOVE_URL,
    }).required;
    const payment = exactPaymentFixture({
      payer,
      feePayer,
      treasury: treasury.addr.toString(),
    });

    for (const fixture of verifyCases) {
      await expect(rail.verify(payment.header, required)).resolves.toEqual({
        ok: false,
        reason: fixture.expected,
        detail: fixture.reason,
      });
    }
    await expect(rail.settle(payment.header, required)).resolves.toMatchObject({
      ok: false,
      reason: "expired",
    });
    await expect(rail.settle(payment.header, required)).resolves.toMatchObject({
      ok: false,
      reason: "rejected",
    });

    async function unavailableResult(
      operation: "verify" | "settle",
      response: (init: RequestInit | undefined) => Promise<Response>,
    ) {
      let calls = 0;
      const unavailableFetch = vi.fn<typeof globalThis.fetch>(
        async (_input, init) => {
          calls += 1;
          return calls === 1
            ? supported(TESTNET_CAIP2, feePayer)
            : response(init);
        },
      );
      const unavailableRail = createAvmRail(
        { ...config, requestTimeoutMs: 2 },
        { fetch: unavailableFetch },
      );
      await unavailableRail.health();
      const unavailableRequired = unavailableRail.buildPaymentChallenge({
        amountMicroUsdc: 1_000,
        resource: MOVE_URL,
      }).required;
      const result = await unavailableRail[operation](
        payment.header,
        unavailableRequired,
      );
      expect(result).toEqual({ ok: false, reason: "unavailable" });
      expect(unavailableFetch).toHaveBeenCalledTimes(2);
    }

    for (const operation of ["verify", "settle"] as const) {
      await unavailableResult(operation, async () => json({}, 503));
      await unavailableResult(
        operation,
        async () => new Response("not-json", { status: 200 }),
      );
      await unavailableResult(
        operation,
        async (init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      );
    }
  });

  it("avm_local_payment_rejections_never_contact_the_facilitator", async () => {
    const { config, treasury } = accountConfig();
    const payer = algosdk.generateAccount();
    const feePayer = algosdk.generateAccount().addr.toString();
    const otherAddress = algosdk.generateAccount().addr.toString();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(supported(TESTNET_CAIP2, feePayer));
    const rail = createAvmRail(config, { fetch });
    await rail.health();
    const required = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: MOVE_URL,
    }).required;
    const mutations: Array<
      Parameters<typeof exactPaymentFixture>[0]["mutate"]
    > = [
      (payload) => {
        payload.accepted = { ...payload.accepted, scheme: "mock" };
      },
      (payload) => {
        payload.accepted = { ...payload.accepted, network: MAINNET_CAIP2 };
      },
      (payload) => {
        payload.resource.url = "https://osc.example/wrong-resource";
      },
      (payload) => {
        payload.accepted = { ...payload.accepted, asset: "1" };
      },
      (payload) => {
        payload.accepted = { ...payload.accepted, amount: "999" };
      },
      (payload) => {
        payload.accepted = { ...payload.accepted, payTo: otherAddress };
      },
      (payload) => {
        payload.accepted = {
          ...payload.accepted,
          extra: { feePayer: otherAddress, decimals: 6 },
        };
      },
      (payload) => {
        payload.payload.paymentIndex = 0;
      },
      (payload) => {
        payload.payload.paymentGroup[1] = "bm90LW1zZ3BhY2s=";
      },
    ];

    for (const mutate of mutations) {
      const payment = exactPaymentFixture({
        payer,
        feePayer,
        treasury: treasury.addr.toString(),
        mutate,
      });
      await expect(rail.verify(payment.header, required)).resolves.toEqual({
        ok: false,
        reason: "invalid_payment",
      });
      await expect(rail.settle(payment.header, required)).resolves.toEqual({
        ok: false,
        reason: "rejected",
        detail: "invalid payment",
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("avm_transaction_note_balance_and_account_queries_cover_every_pinned_result", async () => {
    const { config, treasury } = accountConfig();
    const address = algosdk.generateAccount().addr.toString();
    const authAddress = algosdk.generateAccount().addr.toString();
    const payoutNote = Buffer.from("osc:payout:job-query").toString("base64");
    const responses = [
      json({ "confirmed-round": 22_000, "pool-error": "" }),
      json({ "confirmed-round": 0, "pool-error": "" }),
      json({}, 404),
      json({ transaction: { id: "INDEXED", "confirmed-round": 22_001 } }),
      json({}, 404),
      json({}, 404),
      json({ "last-round": 22_002 }),
      json({
        transactions: [
          {
            id: "WRONG_SENDER",
            sender: address,
            note: payoutNote,
            "confirmed-round": 1,
          },
          {
            id: "WRONG_NOTE",
            sender: treasury.addr.toString(),
            note: Buffer.from("osc:payout:other").toString("base64"),
            "confirmed-round": 2,
          },
          {
            id: "NEWER",
            sender: treasury.addr.toString(),
            note: payoutNote,
            "confirmed-round": 22_010,
          },
          {
            id: "OLDEST",
            sender: treasury.addr.toString(),
            note: payoutNote,
            "confirmed-round": 22_003,
          },
        ],
      }),
      json({
        amount: 500_000,
        "min-balance": 100_000,
        assets: [
          { "asset-id": 7, amount: 999 },
          { "asset-id": config.usdcAsaId, amount: 12_345 },
        ],
      }),
      json({}, 404),
      json({
        amount: 200_000,
        "min-balance": 300_000,
        "auth-addr": authAddress,
        assets: [{ "asset-id": config.usdcAsaId, amount: 0 }],
      }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("fixture exhausted");
      return response;
    });
    const rail = createAvmRail(config, { fetch });

    await expect(rail.getTransactionStatus("CONFIRMED")).resolves.toEqual({
      status: "confirmed",
      confirmedRound: 22_000,
    });
    await expect(rail.getTransactionStatus("PENDING")).resolves.toEqual({
      status: "pending",
    });
    await expect(rail.getTransactionStatus("INDEXED")).resolves.toEqual({
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
    await expect(rail.getBalances(address)).resolves.toEqual({
      usdcMicroUsdc: 12_345,
      algoMicroAlgo: 500_000,
    });
    await expect(rail.getAccountInfo(address)).resolves.toEqual({
      exists: false,
      rekeyed: false,
      optedInUsdc: false,
      spendableAlgoMicro: 0,
    });
    await expect(rail.getAccountInfo(address)).resolves.toEqual({
      exists: true,
      rekeyed: true,
      optedInUsdc: true,
      spendableAlgoMicro: 0,
    });
    expect(fetch.mock.calls[2]?.[0].toString()).toContain("/pending/INDEXED");
    expect(fetch.mock.calls[3]?.[0].toString()).toContain(
      "indexer.example/v2/transactions/INDEXED",
    );

    const unavailableRail = createAvmRail(config, {
      fetch: vi.fn(async () => {
        throw new Error("transport unavailable");
      }),
    });
    await expectUnavailable(unavailableRail.getTransactionStatus("TX"));
    await expectUnavailable(unavailableRail.findPayoutByNote("job"));
    await expectUnavailable(unavailableRail.getBalances(address));
    await expectUnavailable(unavailableRail.getAccountInfo(address));
  });

  it("avm_network_parameters_and_every_outbound_wait_are_bounded", async () => {
    const { config, treasury } = accountConfig();
    const recipient = algosdk.generateAccount().addr.toString();
    const wrongGenesisRail = createAvmRail(config, {
      fetch: vi.fn(async () =>
        suggestedParams(TESTNET_CAIP2, {
          genesisHash: MAINNET_CAIP2.slice("algorand:".length),
        }),
      ),
    });
    await expect(
      wrongGenesisRail.preparePayouts([
        { jobId: "wrong-genesis", recipient, amountMicroUsdc: 1 },
      ]),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const unsafeWindowRail = createAvmRail(config, {
      fetch: vi.fn(async () =>
        suggestedParams(TESTNET_CAIP2, { round: Number.MAX_SAFE_INTEGER }),
      ),
    });
    await expect(
      unsafeWindowRail.preparePayouts([
        { jobId: "unsafe-window", recipient, amountMicroUsdc: 1 },
      ]),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const preparer = createAvmRail(config, {
      fetch: vi.fn(async () => suggestedParams()),
    });
    const preparedPayout = await preparer.preparePayouts([
      { jobId: "timeout", recipient, amountMicroUsdc: 1 },
    ]);
    const preparedFunding = await preparer.prepareFunding({
      player: recipient,
      leg: "algo",
      amount: 1,
    });
    const clientSigned = signedClientTransaction(algosdk.generateAccount());
    const feePayer = algosdk.generateAccount().addr.toString();
    const abortedUrls: string[] = [];
    let calls = 0;
    const timeoutFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      calls += 1;
      if (calls === 1) return supported(TESTNET_CAIP2, feePayer);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedUrls.push(String(input));
          reject(init.signal?.reason);
        });
      });
    });
    const rail = createAvmRail(
      { ...config, requestTimeoutMs: 2 },
      { fetch: timeoutFetch },
    );
    await rail.health();
    const required = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: MOVE_URL,
    }).required;
    const payment = exactPaymentFixture({
      payer: algosdk.generateAccount(),
      feePayer,
      treasury: treasury.addr.toString(),
    });

    await expect(rail.verify(payment.header, required)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(rail.settle(payment.header, required)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(rail.health()).resolves.toBe(false);
    await expectUnavailable(
      rail.preparePayouts([
        { jobId: "bounded", recipient, amountMicroUsdc: 1 },
      ]),
    );
    await expectUnavailable(rail.buildOptInTxn(recipient));
    await expectUnavailable(rail.getTransactionStatus("TX"));
    await expectUnavailable(rail.findPayoutByNote("bounded"));
    await expectUnavailable(rail.findFundingByNote(recipient, "algo"));
    await expectUnavailable(rail.getBalances(recipient));
    await expectUnavailable(rail.getAccountInfo(recipient));
    await expect(rail.submitPrepared(preparedPayout)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(rail.submitPrepared(preparedFunding)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(rail.submitSignedTransaction(clientSigned)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(abortedUrls).toHaveLength(calls - 1);
    expect(abortedUrls).toEqual(
      expect.arrayContaining([
        "https://facilitator.example/verify",
        "https://facilitator.example/settle",
        "https://facilitator.example/supported",
        "https://algod.example/v2/transactions/params",
        "https://algod.example/v2/transactions",
        "https://indexer.example/v2/transactions?address=" +
          rail.treasuryAddress +
          "&address-role=sender&note-prefix=b3NjOnBheW91dDpib3VuZGVk",
      ]),
    );

    const indexerAborts: string[] = [];
    let indexerCalls = 0;
    const indexerTimeoutRail = createAvmRail(
      { ...config, requestTimeoutMs: 2 },
      {
        fetch: vi.fn(async (input, init) => {
          indexerCalls += 1;
          if (indexerCalls === 1) return json({}, 404);
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              indexerAborts.push(String(input));
              reject(init.signal?.reason);
            });
          });
        }),
      },
    );
    await expectUnavailable(indexerTimeoutRail.getTransactionStatus("TX"));
    expect(indexerAborts).toEqual([
      "https://indexer.example/v2/transactions/TX",
    ]);
  });

  it("avm_construction_errors_results_and_enumerable_state_never_expose_the_treasury_mnemonic", async () => {
    const { config, treasury } = accountConfig();
    const secret = config.treasuryMnemonic;
    const payer = algosdk.generateAccount();
    const recipient = algosdk.generateAccount();
    const feePayer = algosdk.generateAccount().addr.toString();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/supported")) {
        return supported(TESTNET_CAIP2, feePayer);
      }
      if (url.endsWith("/v2/transactions/params")) return suggestedParams();
      if (url.endsWith("/verify")) {
        return json({ isValid: false, invalidReason: secret }, 400);
      }
      if (url.endsWith("/settle")) {
        return json(
          {
            success: false,
            transaction: "",
            network: TESTNET_CAIP2,
            errorReason: secret,
          },
          400,
        );
      }
      if (url.endsWith("/v2/transactions") && init?.method === "POST") {
        return new Response(secret, { status: 400 });
      }
      throw new Error(secret);
    });
    const rail = createAvmRail(config, { fetch });
    await rail.health();
    const required = rail.buildPaymentChallenge({
      amountMicroUsdc: 1_000,
      resource: MOVE_URL,
    }).required;
    const payment = exactPaymentFixture({
      payer,
      feePayer,
      treasury: treasury.addr.toString(),
    });
    const payout = await rail.preparePayouts([
      {
        jobId: "redaction",
        recipient: recipient.addr.toString(),
        amountMicroUsdc: 1,
      },
    ]);
    const funding = await rail.prepareFunding({
      player: recipient.addr.toString(),
      leg: "usdc",
      amount: 1,
    });
    const values: unknown[] = [
      rail,
      await rail.verify(payment.header, required),
      await rail.settle(payment.header, required),
      await rail.submitPrepared(payout),
      await rail.submitPrepared(funding),
      await rail.submitSignedTransaction(signedClientTransaction(recipient)),
    ];
    try {
      await rail.getBalances(recipient.addr.toString());
    } catch (error) {
      values.push(error);
    }
    try {
      createAvmRail({ ...config, treasuryMnemonic: "not a mnemonic" });
    } catch (error) {
      values.push(error);
    }

    const walk = (value: unknown, seen = new Set<unknown>()): void => {
      if (typeof value === "string") expect(value).not.toContain(secret);
      if (value instanceof Error) {
        expect(value.message).not.toContain(secret);
        expect(value.stack).not.toContain(secret);
      }
      if (
        (typeof value !== "object" && typeof value !== "function") ||
        value === null ||
        seen.has(value)
      ) {
        return;
      }
      seen.add(value);
      for (const key of Object.keys(value)) {
        walk((value as Record<string, unknown>)[key], seen);
      }
    };
    for (const value of values) walk(value);
    expect(JSON.stringify(values)).not.toContain(secret);
    expect(Object.keys(rail)).not.toContain("config");
    expect(() =>
      createAvmRail({ ...config, facilitatorUrl: "file:///tmp/rail" }),
    ).toThrowError(
      expect.objectContaining<Partial<RailError>>({ code: "CONTRACT" }),
    );
  });
});
