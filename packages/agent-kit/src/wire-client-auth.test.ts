import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";
import {
  claimStatusViewSchema,
  claimViewSchema,
  createOscClient,
  decodeOscApiError,
  errorEnvelopeSchema,
  finishedGameItemSchema,
  guardAuthChallenge,
  metaSchema,
  moveReceiptSchema,
  OSC_SERVER_ERROR_CODES,
  ongoingGameItemSchema,
  pageSchema,
  paymentRequiredSchema,
  profileSchema,
  replayViewSchema,
  type Signer,
  signAuthChallenge,
  TESTNET_CAIP2,
} from "./index.js";

const at = "2026-07-25T12:00:00.000Z";
const payer = algosdk.generateAccount();
const treasury = algosdk.generateAccount();

const meta = {
  name: "One Step Chess",
  network: {
    caip2: "mock:local",
    usdcAssetId: "31566704",
    treasuryAddress: treasury.addr.toString(),
    facilitatorUrl: "https://facilitator.example",
    explorerBaseUrl: "https://explorer.example",
    algodUrl: "https://algod.example",
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
    claimTtlSeconds: { human: 180, agent: 90, endspiel: 45 },
    timerRevealSeconds: 30,
    minPlyIntervalSeconds: 10,
    cooldownPlies: 4,
    nextGameNudgeSeconds: 15,
  },
  quotas: { human: 10, agent: 100, demo: 1, windowMinutes: 60 },
  pool: { target: 12, active: 8, endspiel: 2 },
  status: { mode: "running" as const, banner: null },
  turnstileSiteKey: "site-key",
  stats: {
    humanMoves: 1,
    playersRegistered: 2,
    gamesFinished: 3,
    movesSettled: 4,
  },
  rules: "Make exactly one move.",
  docs: {
    llms: "https://osc.example/llms.txt",
    openapi: "https://osc.example/api/v1/openapi.json",
    mcpPackage: "@onestepchess/mcp",
    agentKitPackage: "@onestepchess/agent-kit",
    repo: "https://github.com/sergeyshemyakov/onestepchess",
  },
};

const move = { uci: "e2e4", san: "e4" };
const claim = {
  claimId: "clm_fixture",
  yourSide: "white" as const,
  phase: "normal" as const,
  demo: false,
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  legalMoves: [move],
  stakeMicroUsdc: 1000,
  deadline: "2026-07-25T12:01:30.000Z",
};
const receipt = {
  status: "moved" as const,
  move,
  debitMicroUsdc: 1000,
  txid: "mocktx_1",
  explorerUrl: "https://explorer.example/tx/mocktx_1",
  fenAfterYourMove:
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
};
const profile = {
  address: payer.addr.toString(),
  kind: "agent" as const,
  nickname: "swift_rook",
  createdAt: at,
  stats: { moves: 1, wins: 1, draws: 0, losses: 0, winratePct: 100 },
  netPnlMicroUsdc: 200,
  quotas: {
    staked: { limit: 100, remaining: 99, resetsAt: at },
    demo: { limit: 0, remaining: 0, resetsAt: null },
  },
  deprioritizedUntil: null,
};
const ongoing = {
  yourMove: move,
  yourSide: "white" as const,
  demo: false,
  stakeMicroUsdc: 1000,
  claimedAt: at,
  movedAt: at,
  fenBeforeYourMove: claim.fen,
  payTxid: "mockpay_one",
};
const finished = {
  ...ongoing,
  demo: false as const,
  gameId: "gm_fixture",
  gameName: "gentle_rook",
  finalFen: receipt.fenAfterYourMove,
  result: "white" as const,
  termination: "checkmate" as const,
  yourPly: 1,
  payTxid: "mockpay_one",
  payoutMicroUsdc: 1900,
  payoutTxid: "mockpayout_one",
  payoutStatus: "confirmed" as const,
  statsCounted: true as const,
  finishedAt: at,
};
const demoFinished = {
  yourMove: move,
  yourSide: "black" as const,
  demo: true as const,
  stakeMicroUsdc: 0,
  claimedAt: at,
  movedAt: at,
  result: "draw" as const,
  termination: "stalemate" as const,
  payoutMicroUsdc: 0 as const,
  payoutStatus: null,
  statsCounted: false as const,
  finishedAt: at,
};
const replay = {
  gameId: "gm_fixture",
  name: "gentle_rook",
  result: "white" as const,
  termination: "checkmate" as const,
  endspielPly: null,
  createdAt: at,
  finishedAt: at,
  plies: [
    {
      ply: 1,
      side: "white" as const,
      move,
      fenAfter: receipt.fenAfterYourMove,
      author: {
        nickname: "swift_rook",
        kind: "agent" as const,
        winratePct: 100,
      },
      stakeMicroUsdc: 1000,
      demo: false,
    },
  ],
  pgn: '[Result "1-0"]\n\n1. e4 1-0',
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function challenge(
  account = payer,
  caip2 = "mock:local",
): {
  nonce: string;
  expiresAt: string;
  arc60Payload: {
    data: string;
    metadata: { scope: 1; encoding: "base64" };
  };
  fallbackTxnB64: string;
} {
  const nonce = "fixture-nonce";
  const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    note: new TextEncoder().encode(`osc-auth:${nonce}`),
    suggestedParams: {
      flatFee: true,
      fee: 0,
      minFee: 1000,
      firstValid: 1,
      lastValid: 1,
      genesisID: "fixture-v1",
      genesisHash: Buffer.from(
        caip2 === "mock:local" ? TESTNET_CAIP2.slice(9) : caip2.slice(9),
        "base64",
      ),
    },
  });
  return {
    nonce,
    expiresAt: "2026-07-25T12:05:00.000Z",
    arc60Payload: {
      data: "e30=",
      metadata: { scope: 1, encoding: "base64" },
    },
    fallbackTxnB64: Buffer.from(
      algosdk.encodeUnsignedTransaction(transaction),
    ).toString("base64"),
  };
}

function signer(account = payer, spy = vi.fn()) {
  const result: Signer = {
    address: account.addr.toString(),
    sign(bytes) {
      spy(bytes);
      return algosdk.decodeUnsignedTransaction(bytes).signTxn(account.sk);
    },
  };
  return { signer: result, spy };
}

describe("agent-kit wire client and authentication", () => {
  it("agent_wire_schemas_parse_server_goldens_and_reject_drift", () => {
    const paymentRequired = {
      x402Version: 2 as const,
      resource: {
        url: "https://osc.example/api/v1/claims/clm_fixture/move",
      },
      accepts: [
        {
          scheme: "mock" as const,
          network: "mock:local",
          asset: "31566704",
          amount: "1000",
          payTo: treasury.addr.toString(),
          maxTimeoutSeconds: 120,
          extra: {},
        },
      ],
    };
    const fixtures = [
      [claimViewSchema, claim],
      [moveReceiptSchema, receipt],
      [ongoingGameItemSchema, ongoing],
      [finishedGameItemSchema, finished],
      [finishedGameItemSchema, demoFinished],
      [
        claimStatusViewSchema,
        { status: "open", claim, paymentState: "verifying" },
      ],
      [claimStatusViewSchema, { status: "moved", receipt }],
      [claimStatusViewSchema, { status: "expired" }],
      [replayViewSchema, replay],
      [profileSchema, profile],
      [metaSchema, meta],
      [
        pageSchema(ongoingGameItemSchema),
        { items: [ongoing], page: 1, pageCount: 1, total: 1 },
      ],
      [
        errorEnvelopeSchema,
        {
          error: "ILLEGAL_MOVE",
          hint: "choose a legal move",
          docs: "https://osc.example/llms.txt#err-illegal_move",
          legalMoves: [move],
        },
      ],
      [paymentRequiredSchema, paymentRequired],
    ] as const;
    for (const [schema, fixture] of fixtures) {
      expect(schema.parse({ ...fixture, futureField: true })).toBeDefined();
    }

    for (const field of ["gameId", "name", "ply", "history"]) {
      expect(
        claimViewSchema.safeParse({ ...claim, [field]: "forbidden" }).success,
      ).toBe(false);
    }
    expect(
      claimViewSchema.safeParse({ ...claim, phase: "rapid" }).success,
    ).toBe(false);
    expect(
      finishedGameItemSchema.safeParse({ ...finished, result: "WHITE" })
        .success,
    ).toBe(false);
    expect(claimStatusViewSchema.safeParse({ status: "pending" }).success).toBe(
      false,
    );
    expect(
      paymentRequiredSchema.safeParse({
        ...paymentRequired,
        accepts: [{ ...paymentRequired.accepts[0], scheme: "future" }],
      }).success,
    ).toBe(false);
  });

  it("agent_error_model_preserves_server_taxonomy_and_typed_additions", async () => {
    for (const code of OSC_SERVER_ERROR_CODES) {
      const error = await decodeOscApiError(
        json(
          {
            error: code,
            hint: `hint for ${code}`,
            docs: `https://osc.example/llms.txt#err-${code.toLowerCase()}`,
            ...(code === "NICKNAME_TAKEN" ? { suggestion: "gentle_rook" } : {}),
            ...(code === "ILLEGAL_MOVE" || code === "AMBIGUOUS_MOVE"
              ? { legalMoves: [move] }
              : {}),
            ...(code === "INTERNAL" ? { requestId: "req_1" } : {}),
          },
          400,
          { "Retry-After": "17" },
        ),
      );
      expect(error.code).toBe(code);
      expect(error.retryAfterSeconds).toBe(17);
      if (code === "NICKNAME_TAKEN") {
        expect(error.suggestion).toBe("gentle_rook");
      }
      if (code === "ILLEGAL_MOVE" || code === "AMBIGUOUS_MOVE") {
        expect(error.legalMoves).toEqual([move]);
      }
      if (code === "INTERNAL") expect(error.requestId).toBe("req_1");
    }
    const future = await decodeOscApiError(
      json(
        {
          error: "FUTURE_SERVER_CODE",
          hint: "future",
          docs: "https://osc.example/llms.txt",
        },
        418,
      ),
    );
    expect(future).toMatchObject({ code: "FUTURE_SERVER_CODE", status: 418 });
  });

  it("osc_client_maps_every_public_method_and_parses_before_return", async () => {
    const accountSigner = signer();
    let nickname = profile.nickname;
    let claimCalls = 0;
    let currentInvalid = false;
    const outcomes = (["white", "black", "draw", "aborted"] as const).flatMap(
      (result) =>
        (["white", "black"] as const).map((yourSide, index) => ({
          ...finished,
          gameId: `gm_${result}_${yourSide}`,
          result,
          yourSide,
          yourPly: index + 1,
        })),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const target = new URL(input.toString());
      const path = target.pathname;
      if (path.endsWith("/meta")) return json(meta);
      if (path.endsWith("/auth/challenge")) return json(challenge());
      if (path.endsWith("/auth/verify")) {
        const body = JSON.parse(String(init?.body));
        expect(body.kind).toBe("agent");
        return json({
          player: {
            address: payer.addr.toString(),
            kind: "agent",
            nickname,
            createdAt: at,
          },
          jwt: "secret-jwt",
        });
      }
      if (path.endsWith("/my/profile") && init?.method === "PATCH") {
        nickname = JSON.parse(String(init.body)).nickname;
        return json({
          player: {
            address: payer.addr.toString(),
            kind: "agent",
            nickname,
            createdAt: at,
          },
        });
      }
      if (path.endsWith("/my/profile")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer secret-jwt",
        );
        return json({
          ...profile,
          nickname,
          ...(target.searchParams.get("include") === "balances"
            ? { balances: { usdcMicroUsdc: 10_000, algoMicroAlgo: 250_000 } }
            : {}),
        });
      }
      if (path.endsWith("/claims") && init?.method === "POST") {
        claimCalls += 1;
        if (claimCalls === 3) {
          return json(null, 204, { "Retry-After": "11" });
        }
        return json({ claim }, claimCalls === 2 ? 201 : 200);
      }
      if (path.endsWith("/claims/current")) {
        return json({
          claim: currentInvalid ? { ...claim, history: [] } : claim,
        });
      }
      if (path.endsWith("/claims/clm_fixture/status")) {
        return json({ status: "open", claim, paymentState: null });
      }
      if (path.endsWith("/my/games")) {
        return target.searchParams.get("status") === "ongoing"
          ? json({ items: [ongoing], page: 1, pageCount: 1, total: 1 })
          : json({ items: outcomes, page: 1, pageCount: 1, total: 8 });
      }
      if (path.endsWith("/games/gm_fixture/replay")) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return json(replay);
      }
      if (path.endsWith("/auth/logout")) return json(null, 204);
      throw new Error(`unexpected route ${target}`);
    });
    const client = createOscClient({
      serverUrl: "https://osc.example",
      signer: accountSigner.signer,
      fetch,
    });

    await expect(client.meta()).resolves.toEqual(meta);
    await expect(client.register()).resolves.toMatchObject({
      nickname: "swift_rook",
    });
    await expect(client.whoami()).resolves.toMatchObject({ kind: "agent" });
    await expect(
      client.profile({ includeBalances: true }),
    ).resolves.toMatchObject({
      balances: { usdcMicroUsdc: 10_000, algoMicroAlgo: 250_000 },
    });
    await expect(client.setNickname("quiet_knight")).resolves.toMatchObject({
      nickname: "quiet_knight",
    });
    await expect(client.claim()).resolves.toEqual(claim);
    await expect(client.claim()).resolves.toEqual(claim);
    await expect(client.claim()).resolves.toEqual({
      claim: null,
      retryAfterSeconds: 11,
    });
    await expect(client.currentClaim()).resolves.toEqual(claim);
    await expect(client.claimStatus(claim.claimId)).resolves.toMatchObject({
      status: "open",
    });
    await expect(
      client.myGames({ status: "ongoing", page: 1 }),
    ).resolves.toMatchObject({ items: [ongoing] });
    const finishedPage = await client.myGames({
      status: "finished",
      page: 1,
    });
    expect(
      finishedPage.items.map((item) => "outcome" in item && item.outcome),
    ).toEqual([
      "win",
      "loss",
      "loss",
      "win",
      "draw",
      "draw",
      "aborted",
      "aborted",
    ]);
    await expect(client.replay("gm_fixture")).resolves.toEqual(replay);
    currentInvalid = true;
    await expect(client.currentClaim()).rejects.toThrow(
      "GET /claims/current response failed wire validation",
    );
    await expect(client.logout()).resolves.toBeUndefined();
  });

  it("agent_auth_rejects_mutated_challenge_before_signing", () => {
    const fields = [
      "type",
      "sender",
      "receiver",
      "amount",
      "fee",
      "note",
      "validity",
      "genesis",
      "close",
      "rekey",
      "lease",
      "group",
    ] as const;
    const other = algosdk.generateAccount();

    for (const field of fields) {
      const params = {
        flatFee: true,
        fee: field === "fee" ? 1 : 0,
        minFee: 1000,
        firstValid: field === "validity" ? 2 : 1,
        lastValid: 1,
        genesisID: "fixture-v1",
        genesisHash:
          field === "genesis"
            ? Buffer.alloc(32, 1)
            : Buffer.from(TESTNET_CAIP2.slice(9), "base64"),
      };
      const transaction =
        field === "type"
          ? algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
              sender: payer.addr,
              receiver: payer.addr,
              amount: 0,
              assetIndex: 1,
              suggestedParams: params,
            })
          : algosdk.makePaymentTxnWithSuggestedParamsFromObject({
              sender: field === "sender" ? other.addr : payer.addr,
              receiver: field === "receiver" ? other.addr : payer.addr,
              amount: field === "amount" ? 1 : 0,
              note: new TextEncoder().encode(
                field === "note" ? "wrong" : "osc-auth:fixture-nonce",
              ),
              ...(field === "close" ? { closeRemainderTo: other.addr } : {}),
              ...(field === "rekey" ? { rekeyTo: other.addr } : {}),
              ...(field === "lease"
                ? { lease: new Uint8Array(32).fill(1) }
                : {}),
              suggestedParams: params,
            });
      if (field === "group") algosdk.assignGroupID([transaction]);
      const challengeFixture = {
        ...challenge(payer, TESTNET_CAIP2),
        fallbackTxnB64: Buffer.from(
          algosdk.encodeUnsignedTransaction(transaction),
        ).toString("base64"),
      };
      const signing = signer();
      expect(() =>
        signAuthChallenge({
          challenge: challengeFixture,
          meta: {
            ...meta,
            network: { ...meta.network, caip2: TESTNET_CAIP2 },
          },
          signer: signing.signer,
        }),
      ).toThrow(/NETWORK_MISMATCH/);
      expect(signing.spy).not.toHaveBeenCalled();
    }
  });

  it("agent_auth_always_registers_kind_agent_and_keeps_jwt_in_memory", async () => {
    const verifyBodies: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/meta")) return json(meta);
      if (path.endsWith("/auth/challenge")) return json(challenge());
      if (path.endsWith("/auth/verify")) {
        verifyBodies.push(JSON.parse(String(init?.body)));
        return json({
          player: {
            address: payer.addr.toString(),
            kind: "agent",
            nickname: "fresh_agent",
            createdAt: at,
          },
          jwt: "jwt-must-stay-private",
        });
      }
      if (path.endsWith("/my/profile")) return json(profile);
      throw new Error(`unexpected ${path}`);
    });
    const client = createOscClient({
      serverUrl: "https://osc.example",
      signer: signer().signer,
      nickname: "fresh_agent",
      fetch,
    });
    const result = await client.whoami();
    expect(verifyBodies).toEqual([
      expect.objectContaining({
        kind: "agent",
        nickname: "fresh_agent",
        method: "txn",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("jwt-must-stay-private");
    expect(JSON.stringify(client)).not.toContain("jwt-must-stay-private");
  });

  it("agent_auth_reauthenticates_and_replays_exactly_once", async () => {
    let authCount = 0;
    let profileCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/meta")) return json(meta);
      if (path.endsWith("/auth/challenge")) {
        authCount += 1;
        return json(challenge());
      }
      if (path.endsWith("/auth/verify")) {
        return json({
          player: {
            address: payer.addr.toString(),
            kind: "agent",
            nickname: "agent",
            createdAt: at,
          },
          jwt: `jwt-${authCount}`,
        });
      }
      if (path.endsWith("/my/profile")) {
        profileCount += 1;
        if (profileCount === 1) {
          return json(
            { error: "UNAUTHENTICATED", hint: "expired", docs: "" },
            401,
          );
        }
        return json(profile);
      }
      throw new Error(`unexpected ${path}`);
    });
    const client = createOscClient({
      serverUrl: "https://osc.example",
      signer: signer().signer,
      fetch,
    });
    await expect(client.whoami()).resolves.toEqual(profile);
    expect(authCount).toBe(2);
    expect(profileCount).toBe(2);

    profileCount = 0;
    authCount = 0;
    const always401 = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/meta")) return json(meta);
      if (path.endsWith("/auth/challenge")) {
        authCount += 1;
        return json(challenge());
      }
      if (path.endsWith("/auth/verify")) {
        return json({
          player: {
            address: payer.addr.toString(),
            kind: "agent",
            nickname: "agent",
            createdAt: at,
          },
          jwt: `jwt-${authCount}`,
        });
      }
      return json({ error: "UNAUTHENTICATED", hint: "revoked", docs: "" }, 401);
    });
    const failing = createOscClient({
      serverUrl: "https://osc.example",
      signer: signer().signer,
      fetch: always401,
    });
    await expect(failing.whoami()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(authCount).toBe(2);

    const banned = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/meta")) return json(meta);
      if (path.endsWith("/auth/challenge")) {
        authCount += 1;
        return json(challenge());
      }
      if (path.endsWith("/auth/verify")) {
        return json({
          player: {
            address: payer.addr.toString(),
            kind: "agent",
            nickname: "agent",
            createdAt: at,
          },
          jwt: "jwt",
        });
      }
      return json({ error: "BANNED", hint: "banned", docs: "" }, 403);
    });
    authCount = 0;
    await expect(
      createOscClient({
        serverUrl: "https://osc.example",
        signer: signer().signer,
        fetch: banned,
      }).whoami(),
    ).rejects.toMatchObject({ code: "BANNED" });
    expect(authCount).toBe(1);
  });

  it("agent_package_is_esm_barrel_only_and_has_no_private_workspace_dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    );
    expect(packageJson.type).toBe("module");
    expect(packageJson.engines.node).toBe(">=22");
    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    });
    expect(packageJson.bin).toEqual({ "osc-agent": "./dist/cli.js" });
    expect(Object.keys(packageJson.dependencies)).not.toContain(
      "@onestepchess/core",
    );
    expect(Object.keys(packageJson.dependencies)).not.toContain(
      "@onestepchess/server",
    );
    expect(
      Object.keys(packageJson.dependencies).some((name) =>
        name.includes("rail"),
      ),
    ).toBe(false);
    expect(() =>
      guardAuthChallenge({
        challenge: challenge(),
        signerAddress: payer.addr.toString(),
        caip2: "mock:local",
      }),
    ).not.toThrow();
  });
});
