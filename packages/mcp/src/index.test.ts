import { describe, expect, it } from "vitest";
import { createMcpServer, MCP_SERVER_NAME } from "./index.js";

describe("mcp placeholder", () => {
  it("constructs an MCP server", () => {
    expect(createMcpServer()).toBeDefined();
  });

  it("uses the product server name", () => {
    expect(MCP_SERVER_NAME).toBe("onestepchess");
  });
});
