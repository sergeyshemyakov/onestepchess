import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "osc-mcp-smoke-"));
let server;
let transport;
let mcpStderr = "";

async function freePort() {
  const listener = createServer();
  await new Promise((resolveListen, rejectListen) => {
    listener.once("error", rejectListen);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const address = listener.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a local port");
  }
  await new Promise((resolveClose) => listener.close(resolveClose));
  return address.port;
}

function waitForServer(child) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error("mock server did not start")),
      15_000,
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        try {
          const record = JSON.parse(line);
          if (record.msg === "listening") {
            clearTimeout(timeout);
            resolveReady();
          }
        } catch {
          // A partial structured-log line is completed by the next chunk.
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`mock server exited early (${code})`));
    });
  });
}

function result(result, name) {
  if ("toolResult" in result || result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  }
  if (result.structuredContent === undefined) {
    throw new Error(`${name} omitted structuredContent`);
  }
  return result.structuredContent;
}

function pack(directory) {
  const output = execFileSync(
    "pnpm",
    ["pack", "--pack-destination", temporary],
    {
      cwd: directory,
      encoding: "utf8",
    },
  ).trim();
  const archive = output.split("\n").at(-1);
  if (archive === undefined) throw new Error(`pack produced no archive`);
  return archive;
}

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const runtimePath = process.env.PATH ?? "";
  server = spawn(
    join(root, "packages/server/node_modules/.bin/tsx"),
    [join(root, "packages/server/src/index.ts")],
    {
      cwd: root,
      env: {
        PATH: runtimePath,
        RAIL: "mock",
        PORT: String(port),
        DB_PATH: join(temporary, "osc.sqlite"),
        PUBLIC_BASE_URL: base,
        SYSTEM_BANNER: "mock — no real money",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForServer(server);

  const agentKitArchive = pack(join(root, "packages/agent-kit"));
  const mcpArchive = pack(join(root, "packages/mcp"));

  transport = new StdioClientTransport({
    command: "npx",
    args: [
      "--yes",
      "--package",
      agentKitArchive,
      "--package",
      mcpArchive,
      "osc-mcp",
    ],
    cwd: root,
    env: {
      PATH: runtimePath,
      OSC_SERVER_URL: base,
      OSC_KEYFILE: join(temporary, "wallet", "keyfile.json"),
      OSC_EXPECT_NETWORK: "mock",
      OSC_MAX_STAKE_MICROUSDC: "5000",
      OSC_SESSION_BUDGET_MICROUSDC: "100000",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    mcpStderr += chunk.toString();
  });
  const client = new Client({ name: "release-3-smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  if (tools.tools.length !== 12) {
    throw new Error(`expected 12 tools, received ${tools.tools.length}`);
  }
  const wallet = result(
    await client.callTool({ name: "create_wallet", arguments: {} }),
    "create_wallet",
  );
  result(
    await client.callTool({ name: "register", arguments: {} }),
    "register",
  );
  const status = result(
    await client.callTool({ name: "get_wallet_status", arguments: {} }),
    "get_wallet_status",
  );
  const claim = result(
    await client.callTool({ name: "claim_move", arguments: { format: "fen" } }),
    "claim_move",
  );
  const legalMoves = claim.legalMoves;
  if (
    typeof claim.claimId !== "string" ||
    !Array.isArray(legalMoves) ||
    typeof legalMoves[0]?.uci !== "string"
  ) {
    throw new Error("claim_move returned no playable claim");
  }
  const receipt = result(
    await client.callTool({
      name: "make_move",
      arguments: { claim_id: claim.claimId, move: legalMoves[0].uci },
    }),
    "make_move",
  );
  if (receipt.status !== "moved" || receipt.debitMicroUsdc !== 1_000) {
    throw new Error("make_move returned an invalid mock receipt");
  }
  await client.close();
  transport = undefined;

  const redactionSurface = JSON.stringify({
    wallet,
    status,
    claim,
    receipt,
    stderr: mcpStderr,
  });
  if (/mnemonic|private.?key/i.test(redactionSurface)) {
    throw new Error("smoke output contained key-material labels");
  }
  process.stdout.write(
    `${JSON.stringify({
      command: "npx --package <packed @onestepchess/mcp> osc-mcp",
      tools: tools.tools.length,
      walletReady: status.ready,
      claimId: claim.claimId,
      move: receipt.move,
      debitMicroUsdc: receipt.debitMicroUsdc,
      txid: receipt.txid,
      stderrBytes: Buffer.byteLength(mcpStderr),
      keyMaterialFound: false,
    })}\n`,
  );
} catch (error) {
  if (mcpStderr.length > 0) {
    process.stderr.write(`packed MCP stderr:\n${mcpStderr}`);
  }
  throw error;
} finally {
  await transport?.close();
  if (server !== undefined && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolveExit) => server.once("exit", resolveExit));
  }
  rmSync(temporary, { recursive: true, force: true });
}
