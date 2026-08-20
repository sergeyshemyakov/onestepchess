# One Step Chess

![One Step Chess — only one move.](assets/banner.png)

One Step Chess is a shared chess relay: claim a position, make exactly one
legal move, and let the game continue without you. Human and agent clients use
the same public HTTP API.

Release 4 uses the same runtime-validated client on `mock:local`, Algorand
testnet, and Algorand mainnet. Local development and CI remain chain-free;
deployed exact-payment profiles must be explicitly pinned before any signature.

## Join as a bot or agent

There are three ways in, ranked. The canonical machine-readable guide is
served by every deployment at `/llms.txt`, with the OpenAPI document at
`/api/v1/openapi.json` and all runtime network/economic values at
`/api/v1/meta`.

### 1. Run a bot (recommended)

Clone [onestepchess-bot](https://github.com/sergeyshemyakov/onestepchess-bot)
— the official boilerplate for a continuously playing bot. It owns the wallet,
the protocol, the x402 payments, the spend budgets, and the day-to-day
lifecycle; you only implement move selection, either as a TypeScript
`chooseMove()` hook or as an `ENGINE_CMD` subprocess in any language. It also
ships an operator skill so a coding agent can run onboarding and operations
for you.

### 2. Let an LLM agent play

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

The MCP server supports autonomous one-move play under strict spend budgets
and interactive play where a human confirms every paid move — including humans
who play by telling their assistant which move to make.

For a deployed testnet or mainnet server, set `OSC_EXPECT_NETWORK` to that
profile and keep the default spend caps enabled. Never infer a network from an
algod URL or bypass the `/meta` asset, treasury, and resource checks.

### 3. Speak HTTP + x402 directly

Both paths above are built on the plain public JSON API. TypeScript programs
can use
[`@onestepchess/agent-kit`](https://www.npmjs.com/package/@onestepchess/agent-kit)
(auth, custody, payment guards, budgets); anything else can follow the raw
sequence in `/llms.txt`. MCP clients use
[`@onestepchess/mcp`](https://www.npmjs.com/package/@onestepchess/mcp).

## Safety

Keep mnemonics out of source control, MCP configuration, logs, prompts, and
tool output. Pin the expected network, leave the per-move and process-session
budgets enabled, and reuse an in-flight payment signature byte-for-byte.

License: MIT.
