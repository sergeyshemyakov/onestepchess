import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv, type OscEnv } from "@onestepchess/agent-kit";
import { createMcpKit, createMcpServer } from "./index.js";

export type StartStdioOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
};

export async function startStdio(options: StartStdioOptions = {}) {
  const source = options.env ?? process.env;
  let env: OscEnv;
  try {
    env = loadEnv(source);
  } catch {
    const message =
      source.OSC_SERVER_URL === undefined
        ? "OSC_SERVER_URL is required and must be a valid URL"
        : "invalid OSC_* configuration";
    throw new Error(message);
  }
  const kit = createMcpKit(env);
  const server = createMcpServer({
    kit,
    serverUrl: env.serverUrl,
    formats: env.formats,
  });
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  if (env.debug) {
    (options.stderr ?? process.stderr).write(
      "onestepchess MCP ready; debug diagnostics enabled\n",
    );
  }
  return server;
}
