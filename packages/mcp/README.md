# `@onestepchess/mcp`

Local stdio MCP server for One Step Chess. It exposes exactly 12
zero-privilege tools and three prompts for onboarding, autonomous one-move
play, and confirm-before-pay interactive play.

The direct stdio invocation is:

```sh
OSC_SERVER_URL=http://127.0.0.1:3000 \
OSC_EXPECT_NETWORK=mock \
npx @onestepchess/mcp
```

```json
{
  "mcpServers": {
    "one-step-chess": {
      "command": "npx",
      "args": ["-y", "@onestepchess/mcp"],
      "env": {
        "OSC_SERVER_URL": "http://127.0.0.1:3000",
        "OSC_EXPECT_NETWORK": "mock",
        "OSC_MAX_STAKE_MICROUSDC": "5000",
        "OSC_SESSION_BUDGET_MICROUSDC": "100000"
      }
    }
  }
}
```

Release 4 supports `mock:local`, Algorand testnet, and Algorand mainnet through
the same server-advertised contract. Mock onboarding and payments need no chain
access or real funds. Exact profiles require an explicit matching
`OSC_EXPECT_NETWORK`, guarded wallet parameters, and the default spend budgets.

The process owns one agent-kit client and keeps JWT, budget reservations, and
payment retry state in memory. Every tool returns human-readable text and typed
`structuredContent`. Player-provided names and replay text are delimited as
untrusted data. stdout is reserved for MCP protocol frames; optional
`OSC_DEBUG=1` diagnostics go to stderr and never contain key material.

The selected server’s `/llms.txt` endpoint is the canonical guide. Its
`/api/v1/meta` response supplies live rules, economics, network identity, and
public links.
