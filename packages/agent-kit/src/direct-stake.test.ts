import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import {
  createOscClient,
  directStakeNote,
  type Meta,
  OscApiError,
  OscClientError,
  type Signer,
} from "./index.js";

const at = "2026-09-21T12:00:00.000Z";
const payer = algosdk.generateAccount();
const STAKE_TXID = "TGWXQKZ2N56XRABUEF6YHI3LMF7OPCSTMGVWJZ2TN45QAB2UDEXH";
const receipt = {
  status: "moved" as const,
  move: { uci: "e2e4", san: "e4" },
  debitMicroUsdc: 1000,
  txid: STAKE_TXID,
  explorerUrl: `https://explorer.example/tx/${STAKE_TXID}`,
  fenAfterYourMove:
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
};
const meta: Meta = {
  name: "One Step Chess",
  network: {
    caip2: "mock:local",
    usdcAssetId: "31566704",
    treasuryAddress: "MOCK_TREASURY",
    facilitatorUrl: "https://facilitator.example",
    explorerBaseUrl: "https://explorer.example",
  },
  economics: {
    humanStakeMicroUsdc: 1000,
    agentStakeMicroUsdc: 1000,
    endspielStakeMicroUsdc: 2000,
    drawFeeMicroUsdc: 0,
    protocolFeeBps: 250,
    humanTargetMult: 1.5,
  },
  timing: {
    claimTtlSeconds: { human: 600, agent: 90, endspiel: 30 },
    timerRevealSeconds: 120,
    minPlyIntervalSeconds: 60,
    cooldownPlies: 5,
    nextGameNudgeSeconds: 20,
  },
  quotas: { human: null, agent: 120, demo: 3, windowMinutes: 60 },
  status: { mode: "running", banner: null },
  turnstileSiteKey: "",
  rules: "One move at a time.",
  docs: {
    llms: "https://osc.example/llms.txt",
    openapi: "https://osc.example/api/v1/openapi.json",
    mcpPackage: "@onestepchess/mcp",
    agentKitPackage: "@onestepchess/agent-kit",
    repo: "https://github.com/sergeyshemyakov/onestepchess",
  },
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function authChallenge(): object {
  const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: payer.addr,
    amount: 0,
    note: new TextEncoder().encode("osc-auth:direct"),
    suggestedParams: {
      flatFee: true,
      fee: 0,
      minFee: 1000,
      firstValid: 1,
      lastValid: 1,
      genesisID: "mainnet-v1.0",
      genesisHash: Buffer.alloc(32, 1),
    },
  });
  return {
    nonce: "direct",
    expiresAt: "2026-09-21T12:05:00.000Z",
    arc60Payload: {
      data: "e30=",
      metadata: { scope: 1, encoding: "base64" },
    },
    fallbackTxnB64: Buffer.from(
      algosdk.encodeUnsignedTransaction(transaction),
    ).toString("base64"),
  };
}

type Mode = "receipt" | "mismatch" | "pending" | "retained" | "invalid";

function server(mode: Mode) {
  const moveRequests: { body: unknown; headers: Headers }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(input.toString()).pathname;
    if (path.endsWith("/meta")) return json(meta);
    if (path.endsWith("/auth/challenge")) return json(authChallenge());
    if (path.endsWith("/auth/verify")) {
      return json({
        player: {
          address: payer.addr.toString(),
          kind: "agent",
          nickname: "bot",
          createdAt: at,
        },
        jwt: "jwt",
      });
    }
    if (path.endsWith("/api/v1/moves")) {
      moveRequests.push({
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      switch (mode) {
        case "receipt":
          return json(receipt);
        case "mismatch":
          return json({ ...receipt, txid: "OTHER" });
        case "pending":
          return json(
            {
              status: "payment_pending",
              claimId: "clm_d",
              retryAfterSeconds: 2,
            },
            202,
            { "Retry-After": "2" },
          );
        case "retained":
          return json(
            {
              error: "STAKE_RETAINED",
              hint: "stake transfer did not match an open claim; payment retained",
              docs: "https://osc.example/llms.txt#err-stake_retained",
              stakeTxid: STAKE_TXID,
              retainedMicroUsdc: 999,
              claimStatus: "expired",
            },
            409,
          );
        case "invalid":
          return json(
            {
              error: "PAYMENT_INVALID",
              hint: "stake transaction does not apply to this claim",
              docs: "https://osc.example/llms.txt#err-payment_invalid",
            },
            402,
          );
      }
    }
    throw new Error(`unexpected route ${path}`);
  });
  return { fetch, moveRequests };
}

function signer(spy: ReturnType<typeof vi.fn>): Signer {
  return {
    address: payer.addr.toString(),
    sign(bytes) {
      spy(bytes);
      return algosdk.decodeUnsignedTransaction(bytes).signTxn(payer.sk);
    },
  };
}

async function client(mode: Mode) {
  const stub = server(mode);
  const signs = vi.fn();
  const osc = createOscClient({
    serverUrl: "https://osc.example",
    signer: signer(signs),
    fetch: stub.fetch,
  });
  // Authentication legitimately signs the login challenge once; the direct
  // route itself must never reach for the signer.
  await osc.whoami().catch(() => undefined);
  signs.mockClear();
  return { osc, signs, ...stub };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => error,
  );
}

describe("agent-kit direct stake payments (spec 2026-09-21)", () => {
  it("agent_kit_move_with_stake_txid", async () => {
    const ok = await client("receipt");
    const result = await ok.osc.move("clm_d", "e2e4", {
      stakeTxid: STAKE_TXID,
    });
    expect(result).toEqual(receipt);
    expect(ok.moveRequests).toHaveLength(1);
    expect(ok.moveRequests[0]?.body).toEqual({
      claimId: "clm_d",
      move: "e2e4",
      stakeTxid: STAKE_TXID,
    });
    expect(ok.moveRequests[0]?.headers.has("PAYMENT-SIGNATURE")).toBe(false);
    expect(ok.signs).not.toHaveBeenCalled();

    const mismatch = await client("mismatch");
    const mismatchError = await failure(
      mismatch.osc.move("clm_d", "e2e4", { stakeTxid: STAKE_TXID }),
    );
    expect(mismatchError).toBeInstanceOf(OscClientError);
    expect(mismatchError).toMatchObject({ code: "NETWORK_MISMATCH" });

    const pending = await client("pending");
    const pendingError = await failure(
      pending.osc.move("clm_d", "e2e4", { stakeTxid: STAKE_TXID }),
    );
    expect(pendingError).toBeInstanceOf(OscApiError);
    expect(pendingError).toMatchObject({
      code: "PAYMENT_PENDING",
      status: 202,
      retryAfterSeconds: 2,
    });

    const retained = await client("retained");
    const retainedError = await failure(
      retained.osc.move("clm_d", "e2e4", { stakeTxid: STAKE_TXID }),
    );
    expect(retainedError).toBeInstanceOf(OscApiError);
    expect(retainedError).toMatchObject({
      code: "STAKE_RETAINED",
      status: 409,
      stakeTxid: STAKE_TXID,
      retainedMicroUsdc: 999,
      claimStatus: "expired",
    });

    const invalid = await client("invalid");
    const invalidError = await failure(
      invalid.osc.move("clm_d", "e2e4", { stakeTxid: STAKE_TXID }),
    );
    expect(invalidError).toMatchObject({
      code: "PAYMENT_INVALID",
      status: 402,
    });
    expect(invalid.moveRequests).toHaveLength(1);
    expect(invalid.signs).not.toHaveBeenCalled();

    expect(directStakeNote("clm_x")).toEqual(
      new TextEncoder().encode("osc:stake:clm_x"),
    );
    expect(Buffer.from(directStakeNote("clm_x")).toString("utf8")).toBe(
      "osc:stake:clm_x",
    );
  });
});
