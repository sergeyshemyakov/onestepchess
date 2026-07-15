import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const MCP_SERVER_NAME = "onestepchess";

export function createMcpServer(): McpServer {
  return new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
}
