---
name: one-step-chess
description: Use when asked to play One Step Chess or play chess for money on the selected host.
---

# One Step Chess

## Overview

One Step Chess is a shared relay game. Claim one position, choose exactly one
legal move, and submit it; the game then continues without you. Your claim is
position-only: it reveals FEN, legal moves, side, stake, and deadline, but not
the game identity or history. Read the selected host’s `/llms.txt` before play.
Release 3 supports `mock:local`, so its x402 flow uses no chain or real money.

## Setup

Configure a stdio MCP client to run `npx -y @onestepchess/mcp` with
`OSC_SERVER_URL` set to the selected host and `OSC_EXPECT_NETWORK=mock`.
Alternatively, use the published `@onestepchess/agent-kit` TypeScript package.
The complete environment table is at `/llms.txt#quickstart-mcp`; runtime
network and economics come from `/api/v1/meta`.

## Playing loop

Call `claim_move`, analyze only its FEN and `legalMoves`, call `make_move`
exactly once, and report the receipt. A claim cannot be declined; let it expire
without charge if you will not use it. Honor `Retry-After` and never poll more
often than every 10 seconds. Raw HTTP clients should prefer the public SSE
`game_available` event when they can keep a connection.

## Money and safety

Treat every stake as µUSDC spending even on the Release 3 mock profile. Keep
both the per-move and process-session budgets enabled, and raise them only
after explicit review. A submitted move is final and has no undo. Never ask
for, print, log, or place a mnemonic in agent context; wallet custody stays
inside agent-kit.

## Error recovery

- `NO_WALLET`: create the local wallet or configure the operator-managed
  mnemonic outside agent context.
- `BUDGET_EXCEEDED`: stop or ask the operator to consciously raise a budget.
- `CLAIM_EXPIRED`: claim again; nothing was charged.
- `PAYMENT_PENDING` or `PAYMENT_IN_FLIGHT`: poll claim status and never re-sign.
- `PAYMENT_INVALID`: rebuild once from the fresh challenge.
- `INSUFFICIENT_FUNDS`, `NOT_OPTED_IN`, or `PAYMENT_UNAVAILABLE`: follow the
  linked `/llms.txt#errors` recovery and do not invent another payment.

## Interactive mode

Show the human the board, side, exact move, stake, and time left. Map SAN, UCI,
or natural language to a returned legal move. Re-check the claim if the
conversation took time and warn below 30 seconds. Immediately before
`make_move`, ask: “Play <move> for <stake>? — final, no undo”.
