import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import algosdk from "algosdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKeyfile,
  createWallet,
  FUNDING_CHECKLIST,
  loadSigner,
  type Meta,
  optInUsdc,
  registerFormatter,
  renderClaim,
  renderReplay,
  runCli,
  type Signer,
  TESTNET_CAIP2,
  TESTNET_USDC_ASSET,
  walletStatus,
  writeClaimFiles,
  writeReplayFiles,
} from "./index.js";

const temporaryDirectories: string[] = [];
const at = "2026-07-25T12:00:00.000Z";
const treasury = algosdk.generateAccount();
const walletAccount = algosdk.generateAccount();
const testnetMeta: Meta = {
  name: "One Step Chess",
  network: {
    caip2: TESTNET_CAIP2,
    usdcAssetId: TESTNET_USDC_ASSET,
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
  quotas: { human: 10, agent: 100, demo: 0, windowMinutes: 60 },
  status: { mode: "running", banner: null },
  turnstileSiteKey: "site",
  rules: "one move",
  docs: {
    llms: "https://osc.example/llms.txt",
    openapi: "https://osc.example/api/v1/openapi.json",
    mcpPackage: "@onestepchess/mcp",
    agentKitPackage: "@onestepchess/agent-kit",
    repo: "https://github.com/sergeyshemyakov/onestepchess",
  },
};
const mockMeta: Meta = {
  ...testnetMeta,
  network: {
    ...testnetMeta.network,
    caip2: "mock:local",
    usdcAssetId: "31566704",
  },
};
const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const claim = {
  claimId: "clm_format",
  yourSide: "white" as const,
  phase: "normal" as const,
  demo: false,
  fen: startFen,
  legalMoves: [{ uci: "e2e4", san: "e4" }],
  stakeMicroUsdc: 1000,
  deadline: "2026-07-25T12:01:30.000Z",
};
const replay = {
  gameId: "gm_format",
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
      move: { uci: "e2e4", san: "e4" },
      fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      author: { nickname: "one", kind: "agent" as const, winratePct: null },
      stakeMicroUsdc: 1000,
      demo: false,
    },
    {
      ply: 2,
      side: "black" as const,
      move: { uci: "e7e5", san: "e5" },
      fenAfter: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      author: { nickname: "two", kind: "human" as const, winratePct: 50 },
      stakeMicroUsdc: 1000,
      demo: false,
    },
  ],
  pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
};

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "osc-agent-kit-"));
  temporaryDirectories.push(directory);
  return directory;
}

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signer(account = walletAccount, spy = vi.fn()): Signer {
  return {
    address: account.addr.toString(),
    sign(bytes) {
      spy(bytes);
      return algosdk.decodeUnsignedTransaction(bytes).signTxn(account.sk);
    },
  };
}

function accountBody(input: {
  amount?: number;
  minimum?: number;
  usdc?: number;
}) {
  return {
    amount: input.amount ?? 300_000,
    "min-balance": input.minimum ?? 100_000,
    assets:
      input.usdc === undefined
        ? []
        : [{ "asset-id": Number(TESTNET_USDC_ASSET), amount: input.usdc }],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent-kit custody, wallet, CLI, and formats", () => {
  it("agent_keyfile_is_0600_in_0700_directory_and_never_overwritten", () => {
    const directory = join(temporaryDirectory(), "wallet");
    const path = join(directory, "keyfile.json");
    const created = createKeyfile(path);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(created.address).toMatch(/^[A-Z2-7]{58}$/);
    expect(created.fundingChecklist).toEqual(FUNDING_CHECKLIST);

    const loaded = loadSigner({ keyfile: path });
    const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: loaded.address,
      receiver: loaded.address,
      amount: 0,
      suggestedParams: {
        flatFee: true,
        fee: 0,
        minFee: 1000,
        firstValid: 1,
        lastValid: 1,
        genesisID: "fixture-v1",
        genesisHash: Buffer.alloc(32, 1),
      },
    });
    const signed = algosdk.decodeSignedTransaction(
      loaded.sign(algosdk.encodeUnsignedTransaction(transaction)),
    );
    expect(signed.txn.sender.toString()).toBe(created.address);
    expect(signed.sig).toHaveLength(64);

    const override = algosdk.generateAccount();
    expect(
      loadSigner({
        keyfile: path,
        mnemonic: algosdk.secretKeyToMnemonic(override.sk),
      }).address,
    ).toBe(override.addr.toString());
    expect(() => createKeyfile(path)).toThrowError(
      expect.objectContaining({ code: "KEYFILE_EXISTS" }),
    );
  });

  it("agent_exports_never_expose_mnemonic_or_private_key_material", async () => {
    const path = join(temporaryDirectory(), "keyfile.json");
    const created = createWallet({ keyfile: path });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    const mnemonic = stored.mnemonic as string;
    const loaded = loadSigner({ keyfile: path });
    const publicValues = [
      created,
      loaded,
      await walletStatus(loaded, mockMeta, {
        fetch: vi.fn(async () => {
          throw new Error(mnemonic);
        }),
      }),
      renderClaim(claim, "json"),
      renderReplay(replay, "json"),
    ];
    for (const value of publicValues) {
      expect(JSON.stringify(value)).not.toContain(mnemonic);
      expect(JSON.stringify(value)).not.toContain(stored.addr + mnemonic);
    }
    try {
      loadSigner({ mnemonic: "not a valid mnemonic" });
      throw new Error("expected invalid mnemonic");
    } catch (error) {
      expect(String(error)).not.toContain("not a valid mnemonic");
    }
  });

  it("agent_wallet_status_progresses_through_every_funding_stage", async () => {
    const responses = [
      json({}, 404),
      json(accountBody({})),
      json(accountBody({ usdc: 500 })),
      json(accountBody({ usdc: 2000 })),
    ];
    const fetch = vi.fn(async () => responses.shift() ?? json({}, 500));
    const stages = [];
    for (let index = 0; index < 4; index += 1) {
      stages.push(await walletStatus(signer(), testnetMeta, { fetch }));
    }
    expect(stages.map((status) => status.missing)).toEqual([
      "fund_algo",
      "optin",
      "fund_usdc",
      null,
    ]);
    expect(stages.map((status) => status.ready)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    await expect(
      walletStatus(signer(), testnetMeta, {
        fetch: vi.fn(async () => {
          throw new Error("timeout");
        }),
      }),
    ).rejects.toMatchObject({ code: "ALGOD_UNAVAILABLE" });
  });

  it("agent_optin_is_idempotent_and_rejects_unsafe_txn_before_signing", async () => {
    const signing = vi.fn();
    const currentSigner = signer(walletAccount, signing);
    const alreadyFetch = vi.fn(async () => json(accountBody({ usdc: 0 })));
    await expect(
      optInUsdc(currentSigner, testnetMeta, { fetch: alreadyFetch }),
    ).resolves.toEqual({ alreadyOptedIn: true });
    expect(alreadyFetch).toHaveBeenCalledTimes(1);
    expect(signing).not.toHaveBeenCalled();

    await expect(
      optInUsdc(currentSigner, testnetMeta, {
        fetch: vi.fn(async () =>
          json(accountBody({ amount: 150_000, minimum: 100_000 })),
        ),
      }),
    ).rejects.toMatchObject({
      code: "ALGO_SHORTFALL",
      detail: "51000",
    });
    expect(signing).not.toHaveBeenCalled();

    const unsafeResponses = [
      json(accountBody({})),
      json({
        fee: 1000,
        "min-fee": 1000,
        "last-round": 20_000,
        "genesis-id": "wrong-v1",
        "genesis-hash": Buffer.alloc(32, 2).toString("base64"),
      }),
    ];
    await expect(
      optInUsdc(currentSigner, testnetMeta, {
        fetch: vi.fn(async () => unsafeResponses.shift() ?? json({}, 500)),
      }),
    ).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
    expect(signing).not.toHaveBeenCalled();

    let guardedTransaction: algosdk.Transaction | undefined;
    const safeSigner: Signer = {
      address: walletAccount.addr.toString(),
      sign(bytes) {
        guardedTransaction = algosdk.decodeUnsignedTransaction(bytes);
        return guardedTransaction.signTxn(walletAccount.sk);
      },
    };
    const safeResponses = [
      json(accountBody({})),
      json({
        fee: 1000,
        "min-fee": 1000,
        "last-round": 20_000,
        "genesis-id": "testnet-v1.0",
        "genesis-hash": TESTNET_CAIP2.slice(9),
      }),
      json({ txId: "OPTIN_TX" }),
      json({ "confirmed-round": 20_002, "pool-error": "" }),
    ];
    await expect(
      optInUsdc(safeSigner, testnetMeta, {
        fetch: vi.fn(async () => safeResponses.shift() ?? json({}, 500)),
      }),
    ).resolves.toEqual({ txid: "OPTIN_TX" });
    expect(guardedTransaction?.sender.toString()).toBe(
      walletAccount.addr.toString(),
    );
    expect(guardedTransaction?.assetTransfer?.receiver.toString()).toBe(
      walletAccount.addr.toString(),
    );
    expect(guardedTransaction?.assetTransfer?.amount).toBe(0n);
    expect(guardedTransaction?.assetTransfer?.assetIndex).toBe(
      BigInt(TESTNET_USDC_ASSET),
    );
    expect(guardedTransaction?.fee).toBe(1000n);
    expect(
      (guardedTransaction?.lastValid ?? 0n) -
        (guardedTransaction?.firstValid ?? 0n),
    ).toBe(1000n);
  });

  it("agent_mock_wallet_operations_contact_no_chain", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("chain access forbidden");
    });
    await expect(
      walletStatus(signer(), mockMeta, { fetch }),
    ).resolves.toMatchObject({ ready: true, mock: true });
    await expect(optInUsdc(signer(), mockMeta, { fetch })).resolves.toEqual({
      alreadyOptedIn: true,
      mock: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("osc_agent_onboard_resumes_each_stage_and_is_noop_when_complete", async () => {
    const directory = temporaryDirectory();
    const keyfile = join(directory, "wallet", "keyfile.json");
    const outputs: string[] = [];
    const errors: string[] = [];
    const sleeps = vi.fn(async () => undefined);
    let accountReads = 0;
    let submits = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const target = new URL(input.toString());
      const path = target.pathname;
      if (path.endsWith("/meta")) return json(testnetMeta);
      if (path.endsWith("/auth/challenge")) {
        const address = JSON.parse(String(init?.body)).address as string;
        const nonce = `nonce-${address.slice(0, 4)}`;
        const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject(
          {
            sender: address,
            receiver: address,
            amount: 0,
            note: new TextEncoder().encode(`osc-auth:${nonce}`),
            suggestedParams: {
              flatFee: true,
              fee: 0,
              minFee: 1000,
              firstValid: 1,
              lastValid: 1,
              genesisID: "testnet-v1.0",
              genesisHash: Buffer.from(TESTNET_CAIP2.slice(9), "base64"),
            },
          },
        );
        return json({
          nonce,
          expiresAt: "2026-07-25T12:05:00.000Z",
          arc60Payload: {
            data: "e30=",
            metadata: { scope: 1, encoding: "base64" },
          },
          fallbackTxnB64: Buffer.from(
            algosdk.encodeUnsignedTransaction(transaction),
          ).toString("base64"),
        });
      }
      if (path.endsWith("/auth/verify")) {
        const body = JSON.parse(String(init?.body));
        return json({
          player: {
            address: body.address,
            kind: "agent",
            nickname: "onboard_agent",
            createdAt: at,
          },
          jwt: "cli-jwt",
        });
      }
      if (path.endsWith("/my/profile")) {
        return json({
          address: walletAccount.addr.toString(),
          kind: "agent",
          nickname: "onboard_agent",
          createdAt: at,
          stats: {
            moves: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            winratePct: null,
          },
          netPnlMicroUsdc: 0,
          quotas: {
            staked: { limit: 100, remaining: 100, resetsAt: null },
            demo: { limit: 0, remaining: 0, resetsAt: null },
          },
          deprioritizedUntil: null,
        });
      }
      if (path.includes("/v2/accounts/")) {
        accountReads += 1;
        if (accountReads === 1) return json({}, 404);
        if (accountReads === 2 || accountReads === 3) {
          return json(accountBody({}));
        }
        if (accountReads === 4) return json(accountBody({ usdc: 500 }));
        return json(accountBody({ usdc: 2000 }));
      }
      if (path.endsWith("/v2/transactions/params")) {
        return json({
          fee: 1000,
          "min-fee": 1000,
          "last-round": 20_000,
          "genesis-id": "testnet-v1.0",
          "genesis-hash": TESTNET_CAIP2.slice(9),
        });
      }
      if (path.endsWith("/v2/transactions")) {
        submits += 1;
        return json({ txId: "CLI_OPTIN" });
      }
      if (path.endsWith("/v2/transactions/pending/CLI_OPTIN")) {
        return json({ "confirmed-round": 20_002, "pool-error": "" });
      }
      throw new Error(`unexpected route ${target}`);
    });
    const environment = {
      OSC_SERVER_URL: "https://osc.example",
      OSC_KEYFILE: keyfile,
      OSC_ALGOD_URL: "https://algod.example",
    };
    const dependencies = {
      fetch,
      sleep: sleeps,
      stdout: { write: (text: string) => outputs.push(text) },
      stderr: { write: (text: string) => errors.push(text) },
    };
    await expect(runCli(["onboard"], environment, dependencies)).resolves.toBe(
      0,
    );
    expect(sleeps).toHaveBeenCalledTimes(2);
    expect(submits).toBe(1);
    expect(outputs.join("")).toContain("Waiting for fund_algo");
    expect(outputs.join("")).toContain("Waiting for fund_usdc");
    expect(outputs.join("")).toContain("Ready as onboard_agent");
    expect(errors).toEqual([]);

    accountReads = 100;
    sleeps.mockClear();
    await expect(runCli(["onboard"], environment, dependencies)).resolves.toBe(
      0,
    );
    expect(sleeps).not.toHaveBeenCalled();
    expect(submits).toBe(1);
    const mnemonic = JSON.parse(readFileSync(keyfile, "utf8")).mnemonic;
    expect(outputs.join("")).not.toContain(mnemonic);
  });

  it("agent_board_formatters_match_core_and_replay_goldens", () => {
    const ascii = [
      "8 r n b q k b n r",
      "7 p p p p p p p p",
      "6 . . . . . . . .",
      "5 . . . . . . . .",
      "4 . . . . . . . .",
      "3 . . . . . . . .",
      "2 P P P P P P P P",
      "1 R N B Q K B N R",
      "  a b c d e f g h",
    ].join("\n");
    expect(renderClaim(claim, "ascii").content).toBe(ascii);
    expect(
      renderClaim(claim, "ascii", {
        now: Date.parse("2026-07-25T12:01:00.000Z"),
      }).content,
    ).toBe(`${ascii}\n\nyou play white · stake 0.1¢ · 30s left`);
    expect(renderClaim(claim, "unicode").content).toContain(
      "8 ♜ ♞ ♝ ♛ ♚ ♝ ♞ ♜",
    );
    expect(renderClaim(claim, "fen").content).toBe(startFen);
    expect(JSON.parse(renderClaim(claim, "json").content)).toEqual(claim);
    expect(renderReplay(replay, "pgn").content).toBe(replay.pgn);
    expect(renderReplay(replay, "uci").content).toBe("e2e4 e7e5");
    expect(renderReplay(replay, "san").content).toBe("1. e4 e5 1-0");

    registerFormatter("claim", "custom", (input) => ({
      format: "custom",
      mime: "text/plain",
      ext: "txt",
      content: `custom:${(input as typeof claim).claimId}`,
    }));
    expect(renderClaim(claim, "custom").content).toBe("custom:clm_format");

    const directory = temporaryDirectory();
    writeClaimFiles(claim, directory);
    writeReplayFiles(replay, directory);
    expect(readFileSync(join(directory, "claim-clm_format.txt"), "utf8")).toBe(
      ascii,
    );
    expect(readFileSync(join(directory, "claim-clm_format.fen"), "utf8")).toBe(
      startFen,
    );
    expect(readFileSync(join(directory, "game-gm_format.pgn"), "utf8")).toBe(
      replay.pgn,
    );
    expect(
      readFileSync(join(directory, "claim-clm_format.txt"), "utf8"),
    ).not.toContain("left");
  });
});
