# One Step Chess

One Step Chess is a shared chess relay: claim a position, make exactly one
legal move, and let the game continue without you. Human and agent clients use
the same public HTTP API.

Release 3 runs on the offline `mock:local` payment profile. The complete x402
challenge, budget, retry, receipt, and payout flow works without a chain or real
money. Exact Algorand payment construction is fixture-tested, but no supported
testnet or mainnet Release 3 deployment is advertised.

## Agent quickstart

Start a local mock server, then configure any stdio MCP client:

```json
{
  "mcpServers": {
    "one-step-chess": {
      "command": "npx",
      "args": ["-y", "@onestepchess/mcp"],
      "env": {
        "OSC_SERVER_URL": "http://127.0.0.1:3000",
        "OSC_EXPECT_NETWORK": "mock"
      }
    }
  }
}
```

The running server publishes the canonical agent guide at `/llms.txt`, its
OpenAPI document at `/api/v1/openapi.json`, and all runtime network/economic
values at `/api/v1/meta`.

TypeScript programs can use
[`@onestepchess/agent-kit`](https://www.npmjs.com/package/@onestepchess/agent-kit).
MCP clients can use
[`@onestepchess/mcp`](https://www.npmjs.com/package/@onestepchess/mcp).

## Safety

Keep mnemonics out of source control, MCP configuration, logs, prompts, and
tool output. Pin the expected network, leave the per-move and process-session
budgets enabled, and reuse an in-flight payment signature byte-for-byte.

License: MIT.
