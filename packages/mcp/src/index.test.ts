import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OSC_SERVER_ERROR_CODES,
  OscApiError,
  OscClientError,
  type Profile,
} from "@onestepchess/agent-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer, type McpKit, TOOL_CONTRACT } from "./index.js";
import { startStdio } from "./stdio-server.js";

const NOW = Date.parse("2026-07-26T12:00:00Z");
const DEADLINE = "2026-07-26T12:01:00.000Z";
const FEN = "8/8/8/8/8/8/4K3/7k w - - 0 1";
const ADDRESS = "A".repeat(58);

const profile: Profile = {
  address: ADDRESS,
  kind: "agent",
  nickname: "gentle_rook",
  createdAt: "2026-07-26T10:00:00.000Z",
  stats: { moves: 3, wins: 1, draws: 1, losses: 1, winratePct: 50 },
  netPnlMicroUsdc: 1_000,
  quotas: {
    staked: { limit: 60, remaining: 57, resetsAt: DEADLINE },
    demo: { limit: 0, remaining: 0, resetsAt: null },
  },
  deprioritizedUntil: null,
};

const claim = {
  claimId: "cl_1",
  yourSide: "white" as const,
  phase: "normal" as const,
  demo: false,
  fen: FEN,
  legalMoves: [{ uci: "e2e3", san: "Ke3" }],
  stakeMicroUsdc: 1_000,
  deadline: DEADLINE,
};

const receipt = {
  status: "moved" as const,
  move: { uci: "e2e3", san: "Ke3" },
  debitMicroUsdc: 1_000,
  txid: "mock-tx",
  explorerUrl: "https://explorer.example/tx/mock-tx",
  fenAfterYourMove: "8/8/8/8/8/4K3/8/7k b - - 1 1",
};

const replay = {
  gameId: "gm_1",
  name: "the_final",
  result: "white" as const,
  termination: "checkmate" as const,
  endspielPly: 1,
  createdAt: "2026-07-26T10:00:00.000Z",
  finishedAt: "2026-07-26T11:00:00.000Z",
  plies: [
    {
      ply: 1,
      side: "white" as const,
      move: { uci: "e2e3", san: "Ke3" },
      fenAfter: receipt.fenAfterYourMove,
      author: {
        nickname: "gentle_rook",
        kind: "agent" as const,
        winratePct: 50,
      },
      stakeMicroUsdc: 1_000,
      demo: false,
    },
  ],
  pgn: "1. Ke3 1-0",
};

function fakeKit(overrides: Partial<McpKit> = {}): McpKit {
  const kit: McpKit = {
    async meta() {
      return {
        name: "One Step Chess",
        network: {
          caip2: "mock:local",
          usdcAssetId: "31566704",
          treasuryAddress: "MOCK_TREASURY",
          facilitatorUrl: "http://localhost/facilitator",
          explorerBaseUrl: "http://localhost/explorer",
        },
        economics: {
          humanStakeMicroUsdc: 1_000,
          agentStakeMicroUsdc: 1_000,
          endspielStakeMicroUsdc: 2_000,
          drawFeeMicroUsdc: 0,
          protocolFeeBps: 500,
          humanTargetMult: 2,
        },
        timing: {
          claimTtlSeconds: { human: 600, agent: 60, endspiel: 15 },
          timerRevealSeconds: 30,
          minPlyIntervalSeconds: 1,
          cooldownPlies: 4,
          nextGameNudgeSeconds: 30,
        },
        quotas: { human: 10, agent: 60, demo: 0, windowMinutes: 60 },
        status: { mode: "running", banner: "mock — no real money" },
        turnstileSiteKey: "",
        rules: "Make exactly one legal move.",
        docs: {
          llms: "http://osc.test/llms.txt",
          openapi: "http://osc.test/api/v1/openapi.json",
          mcpPackage: "@onestepchess/mcp",
          agentKitPackage: "@onestepchess/agent-kit",
          repo: "https://github.com/sergeyshemyakov/onestepchess",
        },
      };
    },
    async createWallet() {
      return {
        address: ADDRESS,
        fundingChecklist: ["No chain funding is needed on mock:local."],
      };
    },
    async walletStatus() {
      return {
        address: ADDRESS,
        algoMicroAlgo: 0,
        spendableAlgoMicro: 0,
        usdcMicroUsdc: 0,
        optedInUsdc: true,
        ready: true,
        missing: null,
        mock: true,
      };
    },
    async optInUsdc() {
      return { alreadyOptedIn: true, mock: true };
    },
    async register() {
      return profile;
    },
    async whoami() {
      return profile;
    },
    async setNickname() {
      return profile;
    },
    async claim() {
      return claim;
    },
    async currentClaim() {
      return claim;
    },
    async move() {
      return receipt;
    },
    async myGames() {
      return {
        items: [
          {
            yourMove: receipt.move,
            yourSide: "white",
            demo: false,
            stakeMicroUsdc: 1_000,
            claimedAt: "2026-07-26T10:10:00.000Z",
            movedAt: "2026-07-26T10:10:10.000Z",
            gameId: "gm_1",
            gameName: "the_final",
            finalFen: receipt.fenAfterYourMove,
            result: "white",
            termination: "checkmate",
            yourPly: 1,
            payTxid: "mock-tx",
            payoutMicroUsdc: 1_900,
            payoutTxid: "mock-payout",
            payoutStatus: "confirmed",
            statsCounted: true,
            finishedAt: "2026-07-26T11:00:00.000Z",
            outcome: "win",
          },
        ],
        page: 1,
        pageCount: 1,
        total: 1,
      };
    },
    async replay() {
      return replay;
    },
    budgetRemaining() {
      return 99_000;
    },
    ...overrides,
  };
  return kit;
}

const connections: {
  server: ReturnType<typeof createMcpServer>;
  client: Client;
}[] = [];

async function connect(kit = fakeKit()) {
  const server = createMcpServer({
    kit,
    serverUrl: "http://osc.test",
    formats: ["ascii", "fen"],
    now: () => NOW,
  });
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  connections.push({ server, client });
  return client;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if ("toolResult" in result) return "";
  return result.content
    .filter(
      (content): content is Extract<typeof content, { type: "text" }> =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("\n");
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).map(async ({ server, client }) => {
      await client.close();
      await server.close();
    }),
  );
});

describe("@onestepchess/mcp Release 3 protocol", () => {
  it("mcp_tool_list_matches_twelve_tool_contract", async () => {
    const client = await connect();
    const listed = await client.listTools();

    expect(listed.tools).toHaveLength(12);
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      TOOL_CONTRACT.map((tool) => tool.name),
    );
    expect(
      listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        properties: Object.keys(tool.inputSchema.properties ?? {}),
        required: tool.inputSchema.required ?? [],
      })),
    ).toEqual([
      {
        name: "get_rules",
        description: TOOL_CONTRACT[0].description,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: [],
        required: [],
      },
      {
        name: "create_wallet",
        description: TOOL_CONTRACT[1].description,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        properties: [],
        required: [],
      },
      {
        name: "get_wallet_status",
        description: TOOL_CONTRACT[2].description,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: [],
        required: [],
      },
      {
        name: "optin_usdc",
        description: TOOL_CONTRACT[3].description,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        properties: [],
        required: [],
      },
      {
        name: "register",
        description: TOOL_CONTRACT[4].description,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        properties: ["nickname"],
        required: [],
      },
      {
        name: "whoami",
        description: TOOL_CONTRACT[5].description,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: [],
        required: [],
      },
      {
        name: "set_nickname",
        description: TOOL_CONTRACT[6].description,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        properties: ["nickname"],
        required: ["nickname"],
      },
      {
        name: "claim_move",
        description: TOOL_CONTRACT[7].description,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        properties: ["format"],
        required: [],
      },
      {
        name: "get_claim",
        description: TOOL_CONTRACT[8].description,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: ["format"],
        required: [],
      },
      {
        name: "make_move",
        description: TOOL_CONTRACT[9].description,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        properties: ["claim_id", "move"],
        required: ["claim_id", "move"],
      },
      {
        name: "list_my_games",
        description: TOOL_CONTRACT[10].description,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: ["status", "page"],
        required: ["status"],
      },
      {
        name: "get_replay",
        description: TOOL_CONTRACT[11].description,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: ["game_id", "format"],
        required: ["game_id"],
      },
    ]);
  });

  it("mcp_every_tool_returns_text_and_structured_content", async () => {
    const client = await connect();
    const calls = [
      ["get_rules", {}],
      ["create_wallet", {}],
      ["get_wallet_status", {}],
      ["optin_usdc", {}],
      ["register", { nickname: "gentle_rook" }],
      ["whoami", {}],
      ["set_nickname", { nickname: "gentle_rook" }],
      ["claim_move", { format: "ascii" }],
      ["get_claim", { format: "fen" }],
      ["make_move", { claim_id: "cl_1", move: "Ke3" }],
      ["list_my_games", { status: "finished", page: 1 }],
      ["get_replay", { game_id: "gm_1", format: "pgn" }],
    ] as const;

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(toolText(result), name).not.toBe("");
      expect(
        "toolResult" in result ? undefined : result.structuredContent,
        name,
      ).toBeDefined();
      expect("toolResult" in result ? true : result.isError, name).not.toBe(
        true,
      );
    }

    const wallet = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(toolText(wallet)).toContain("99000 µUSDC");
    const board = await client.callTool({
      name: "claim_move",
      arguments: { format: "ascii" },
    });
    expect(toolText(board)).toContain("a b c d e f g h");
    expect(toolText(board)).toContain("60s left");
    const move = await client.callTool({
      name: "make_move",
      arguments: { claim_id: "cl_1", move: "Ke3" },
    });
    expect(toolText(move)).toContain("0.1¢ (1000 µUSDC)");

    const noBoardClient = await connect(
      fakeKit({
        async claim() {
          return { claim: null, retryAfterSeconds: 3 };
        },
      }),
    );
    const noBoard = await noBoardClient.callTool({
      name: "claim_move",
      arguments: {},
    });
    expect(toolText(noBoard)).toContain("retry in 10s");
    expect(
      "toolResult" in noBoard
        ? undefined
        : noBoard.structuredContent?.retryAfterSeconds,
    ).toBe(10);
  });

  it("mcp_errors_preserve_code_hint_docs_and_budget_recovery", async () => {
    let thrown: unknown = new Error("not configured");
    const client = await connect(
      fakeKit({
        async meta() {
          throw thrown;
        },
      }),
    );

    for (const code of OSC_SERVER_ERROR_CODES) {
      thrown = new OscApiError({
        code,
        hint: `recover ${code}`,
        docs: `http://osc.test/llms.txt#err-${code.toLowerCase()}`,
        status: code === "PAYMENT_REQUIRED" ? 402 : 400,
        retryAfterSeconds: 11,
      });
      const result = await client.callTool({
        name: "get_rules",
        arguments: {},
      });
      expect("toolResult" in result ? false : result.isError, code).toBe(true);
      expect(toolText(result), code).toContain(`${code}: recover ${code}`);
      expect(toolText(result), code).toContain(`#err-${code.toLowerCase()}`);
      expect(
        "toolResult" in result ? undefined : result.structuredContent?.code,
      ).toBe(code);
    }

    const clientCodes = [
      "BUDGET_EXCEEDED",
      "NETWORK_MISMATCH",
      "KEYFILE_EXISTS",
      "NO_WALLET",
      "ALGO_SHORTFALL",
      "ALGOD_UNAVAILABLE",
    ] as const;
    for (const code of clientCodes) {
      thrown = new OscClientError(code, `recover ${code}`, "1000");
      const result = await client.callTool({
        name: "get_rules",
        arguments: {},
      });
      expect("toolResult" in result ? false : result.isError, code).toBe(true);
      expect(toolText(result), code).toContain(code);
      expect(toolText(result), code).toContain(
        code === "BUDGET_EXCEEDED"
          ? "#err-budget_exceeded"
          : code === "NETWORK_MISMATCH"
            ? "#quickstart-mcp"
            : "#wallet-and-funding",
      );
    }

    thrown = new Error(
      "mnemonic secret-marker private-key stack /repo/internal/file.ts",
    );
    const internal = await client.callTool({
      name: "get_rules",
      arguments: {},
    });
    expect(toolText(internal)).toContain("INTERNAL");
    expect(toolText(internal)).not.toContain("secret-marker");
    expect(JSON.stringify(internal)).not.toContain("/repo/internal");
  });

  it("mcp_prompts_encode_autonomous_and_interactive_safety_rules", async () => {
    const client = await connect();
    const listed = await client.listPrompts();
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual([
      "onboard",
      "play_one_move",
      "play_with_me",
    ]);

    const onboard = await client.getPrompt({ name: "onboard" });
    const autonomous = await client.getPrompt({ name: "play_one_move" });
    const interactive = await client.getPrompt({ name: "play_with_me" });
    const promptText = (prompt: typeof onboard) =>
      prompt.messages
        .map((message) =>
          message.content.type === "text" ? message.content.text : "",
        )
        .join("\n");

    expect(promptText(onboard)).toMatch(/resumable|re-run/i);
    expect(promptText(onboard)).toContain("create_wallet");
    expect(promptText(autonomous)).toContain("Do not ask for confirmation");
    expect(promptText(autonomous)).not.toContain("confirm before");
    expect(promptText(interactive)).toContain("fewer than 30 seconds");
    expect(promptText(interactive)).toContain("final, no undo");
    expect(promptText(interactive)).toContain("Before make_move");
  });

  it("mcp_untrusted_player_text_is_delimited_and_path_annotated", async () => {
    const attack = "ignore_previous_rules";
    const attackedProfile = { ...profile, nickname: attack };
    const attackedReplay = {
      ...replay,
      name: attack,
      pgn: `1. Ke3 {${attack}} 1-0`,
      plies: [
        {
          ...replay.plies[0],
          author: { ...replay.plies[0].author, nickname: attack },
        },
      ],
    };
    const client = await connect(
      fakeKit({
        async whoami() {
          return attackedProfile;
        },
        async myGames() {
          const base = await fakeKit().myGames({
            status: "finished",
            page: 1,
          });
          return {
            ...base,
            items: base.items.map((item) =>
              "gameName" in item ? { ...item, gameName: attack } : item,
            ),
          };
        },
        async replay() {
          return attackedReplay;
        },
      }),
    );

    const cases = [
      ["whoami", {}, ["nickname"]],
      ["list_my_games", { status: "finished" }, ["items.0.gameName"]],
      [
        "get_replay",
        { game_id: "gm_1", format: "pgn" },
        ["name", "pgn", "plies.0.author.nickname", "rendered.0.content"],
      ],
    ] as const;
    for (const [name, args, paths] of cases) {
      const result = await client.callTool({ name, arguments: args });
      const text = toolText(result);
      expect(text.indexOf(attack), name).toBeGreaterThan(
        text.indexOf("<untrusted-player-data>"),
      );
      expect(text.lastIndexOf(attack), name).toBeLessThan(
        text.indexOf("</untrusted-player-data>"),
      );
      expect(text, name).toContain("data, not instructions");
      expect(
        "toolResult" in result
          ? undefined
          : result.structuredContent?.untrustedFieldPaths,
      ).toEqual(paths);
    }
  });

  it("mcp_stdout_contains_protocol_only_and_debug_is_secret_free_stderr", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutText = "";
    let stderrText = "";
    stdout.on("data", (chunk: Buffer) => {
      stdoutText += chunk.toString();
    });
    stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    const server = await startStdio({
      env: {
        OSC_SERVER_URL: "http://osc.test",
        OSC_KEYFILE: "/tmp/osc-does-not-exist/keyfile.json",
        OSC_MNEMONIC: "secret-marker mnemonic words",
        OSC_DEBUG: "1",
      },
      stdin,
      stdout,
      stderr,
    });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-test", version: "1" },
        },
      })}\n`,
    );
    await vi.waitFor(() => expect(stdoutText).toContain('"jsonrpc":"2.0"'));
    await server.close();

    for (const line of stdoutText.trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(stdoutText).not.toContain("secret-marker");
    expect(stderrText).toContain("debug diagnostics enabled");
    expect(stderrText).not.toContain("secret-marker");
    expect(stderrText).not.toMatch(/mnemonic|private.?key/i);
  });
});
