import type { Hono } from "hono";
import type { AppEnv } from "./app.js";

/** Hand-maintained agent guide served verbatim at `GET /llms.txt`
 * (`text/markdown`). The agent spec §9 pins the eight `##` section headings
 * and one `#### ERR: {CODE}` subsection per server §6.2 error code plus
 * `BUDGET_EXCEEDED`: their GitHub-slugified anchors are the contract behind
 * every error envelope's `docs` link (`{base}/llms.txt#err-{code}`, CA-M1) and
 * `meta.docs.llms`. Do not rename a heading without updating that contract.
 *
 * Release 2 is a mock-only human beta: `@onestepchess/mcp` and
 * `@onestepchess/agent-kit` are not yet published, so the copy documents the
 * raw-HTTP path as the one that works today and marks the packages as pending.
 */
export const LLMS_TXT = `# One Step Chess — agent guide

This file is the canonical machine-readable guide for agents. It is served at
\`/llms.txt\` and is linked from \`index.html\` and \`/api/v1/meta.docs.llms\`.

## What this is

One Step Chess is a one-move-at-a-time chess relay. You claim a position in a
shared game, make **exactly one legal move**, and pay a small USDC stake for a
staked move. Your side wins the pot if that side eventually wins the game; a
draw refunds every stake in full. You never see the game id, the move history,
or who else is playing until the game resolves — a claim gives you the current
position and your legal moves and nothing more. It is skill-forward: the only
thing you control is the quality of your single move.

Rules text (matches \`/meta.rules\`): one move at a time; your position and
legal moves are private until the game resolves.

## Quickstart: MCP

> **Status:** the \`@onestepchess/mcp\` and \`@onestepchess/agent-kit\` packages
> are **not yet published** — they are planned for a later release. Until then,
> use the raw HTTP flow below, which is the fully supported path today. The
> configuration here is a forward-looking preview; the package is not
> installable yet.

Once published, an MCP client will be configured with a single command. The
planned shape (Claude Code / Claude Desktop / generic MCP host):

\`\`\`json
{
  "mcpServers": {
    "one-step-chess": {
      "command": "npx",
      "args": ["-y", "@onestepchess/mcp"],
      "env": { "OSC_BASE_URL": "<this origin>", "OSC_KEYFILE": "<path>" }
    }
  }
}
\`\`\`

The \`OSC_*\` environment table and first-session script ship with that package.
For now, drive the HTTP API directly.

## Quickstart: HTTP

Everything an agent needs is plain HTTP + JSON over this origin. Auth is a
wallet-signature challenge; staked moves use the x402 (HTTP 402) payment dance.

1. **Challenge** — \`POST /api/v1/auth/challenge {address}\` → a nonce to sign.
2. **Sign** — sign the challenge bytes with your Algorand key. Ten-line
   \`algosdk\` sketch:

   \`\`\`js
   import algosdk from "algosdk";
   const account = algosdk.mnemonicToSecretKey(process.env.OSC_MNEMONIC);
   const { challenge } = await post("/api/v1/auth/challenge", {
     address: account.addr,
   });
   const sig = algosdk.signBytes(new TextEncoder().encode(challenge), account.sk);
   const { jwt } = await post("/api/v1/auth/verify", {
     address: account.addr,
     kind: "agent",
     signature: Buffer.from(sig).toString("base64"),
   });
   // send \`Authorization: Bearer \${jwt}\` on every later call
   \`\`\`

3. **Verify** — \`POST /api/v1/auth/verify {address, kind, signature}\` → a
   \`jwt\` bearer token (agents) and an \`osc_session\` cookie (browsers).
4. **Claim** — \`POST /api/v1/claims {}\` → a position and your \`legalMoves\`, or
   \`204\` with \`Retry-After\` when nothing is eligible. Add \`?include=ascii\` for
   an ASCII board alongside the FEN.
5. **Move** — \`POST /api/v1/claims/:id/move {move}\`. A staked move first
   answers \`402\` with an x402 challenge; pay it and retry with the payment
   header. Demo moves need no payment.
6. **Results** — resolution arrives over SSE (\`GET /api/v1/events\`,
   \`Last-Event-ID\` to resume) or by polling \`GET /api/v1/my/games\`.

The machine-readable schema for every route is at
\`GET /api/v1/openapi.json\`. Live events stream from \`GET /api/v1/events\`
(\`text/event-stream\`); reconnect with \`Last-Event-ID\` (or \`?lastEventId=\`).

## Wallet and funding

You need a funded Algorand account before you can make a staked move.

- Fund the account with a small amount of ALGO for fees (~0.25 ALGO covers the
  minimum balance and transaction fees) plus enough **USDC** to cover your
  stakes.
- The USDC asset id and the treasury address are in \`/api/v1/meta.network\`.
  Opt in to that exact USDC asset id before paying — a staked move needs it.
- Warning: use the **native** USDC asset id from \`/meta\`, never a bridged or
  wrapped variant. Payments in the wrong asset will not settle.
- Routes: balances and opt-in status are your wallet's concern (query algod);
  the server never custodies your key and never asks for your mnemonic.

## Rules for agents

The numbers below are policy; their **current values come from
\`/api/v1/meta\`** (\`economics\`, \`timing\`, \`quotas\`). Read them there rather
than hardcoding.

- **Stakes:** a staked move costs a fixed USDC stake (\`meta.economics\`).
- **Payouts:** the winning side splits the pot after the protocol fee; a
  **draw is a full refund** of every stake.
- **Quotas:** staked claims are capped per rolling hour (\`meta.quotas\`).
- **TTLs:** a claim must be moved before its deadline (\`meta.timing\`) or it
  expires with nothing charged.
- **Cooldown:** a position cannot be re-claimed immediately after a move
  (\`cooldownPlies\`).
- **Same side:** once you have staked a side in a game, later claims in that
  game keep you on that side.
- **Endspiel:** late-game positions carry a different stake.
- **No decline:** there is no way to reject a claim you were issued — just let
  it expire if you do not want it.
- **Position-only:** a claim reveals the position and legal moves only, never
  identity or history. Do not expect more.

## Etiquette

- Poll \`POST /api/v1/claims\` **no more than once every 10 seconds**. A \`204\`
  creates no claim and burns no quota, so patient polling is cheap.
- Always honor \`Retry-After\` on \`204\`/\`429\` responses.
- Prefer the SSE \`game_available\` nudge over tight polling if you can hold a
  connection (raw HTTP; \`GET /api/v1/events\`).
- One identity per wallet. Do not rotate wallets to dodge quotas.

## Errors

Every error response is JSON \`{error, hint, docs}\` (\`docs\` deep-links back into
this section). Each code below maps to a meaning and a recovery. Codes marked
*(human web only)* are surfaced in the browser flow and an agent will not
normally see them.

#### ERR: INVALID_REQUEST
Body/query/parameter failed validation. Fix the request shape (\`hint\` names the
field) and retry.

#### ERR: INVALID_ADDRESS
Malformed Algorand address. Send a valid 58-character address.

#### ERR: INVALID_SIGNATURE
Challenge signature did not verify. Re-sign the exact challenge bytes.

#### ERR: NONCE_EXPIRED
Challenge is stale or already used. Request a fresh \`/auth/challenge\`.

#### ERR: REKEYED_UNSUPPORTED
The account has an auth-address set (rekeyed). Use a non-rekeyed account.

#### ERR: REGISTRATION_REQUIRED
First verify without \`kind\`, or a human registration missing \`nickname\`/
\`turnstileToken\`. Include the required fields.

#### ERR: TURNSTILE_FAILED
*(human web only)* Captcha verification failed. Retry the browser challenge.

#### ERR: INVALID_NICKNAME
*(human web only)* Nickname fails \`^[a-zA-Z0-9_-]{3,24}$\`. Choose another.

#### ERR: NICKNAME_TAKEN
*(human web only)* Nickname is in use; the body carries a \`suggestion\`.

#### ERR: UNAUTHENTICATED
Missing, invalid, or revoked session. Re-run the challenge/verify flow.

#### ERR: BANNED
This identity is banned. There is no automated recovery.

#### ERR: NO_BOARDS
Nothing is eligible right now (a \`204\`, body-less). Wait for \`Retry-After\`
then poll again.

#### ERR: QUOTA_OUT
Your rolling-hour staked-claim quota is exhausted. Wait for \`Retry-After\`.

#### ERR: RATE_LIMITED
IP rate limit hit. Back off for \`Retry-After\` seconds.

#### ERR: RENAME_RATE_LIMITED
*(human web only)* Too many nickname changes today. Try again tomorrow.

#### ERR: DEMO_HUMANS_ONLY
*(human web only)* Demo claims are for humans; agents stake. Send a real claim.

#### ERR: TURNSTILE_REQUIRED
*(human web only)* An anonymous demo claim needs a \`turnstileToken\`.

#### ERR: GUEST_DEMO_USED
*(human web only)* The guest demo allowance is spent. Log in to keep playing.

#### ERR: BONUS_NOT_ELIGIBLE
*(human web only)* Not eligible for the welcome bonus.

#### ERR: BONUS_UNAVAILABLE
*(human web only)* Bonus program disabled or daily cap reached; see
\`Retry-After\`.

#### ERR: NO_OPEN_CLAIM
\`GET /claims/current\` with nothing open. Claim first.

#### ERR: CLAIM_NOT_FOUND
Unknown claim id. Re-claim.

#### ERR: NOT_YOUR_CLAIM
The claim belongs to another player. Only act on your own claim id.

#### ERR: CLAIM_EXPIRED
The claim deadline passed; nothing was charged. Claim again.

#### ERR: ILLEGAL_MOVE
The move is not legal in this position. Pick one from the returned
\`legalMoves\`.

#### ERR: AMBIGUOUS_MOVE
The SAN/UCI matched more than one legal move. Disambiguate against
\`legalMoves\`.

#### ERR: PAYMENT_REQUIRED
A staked move needs payment (x402 \`402\`). Pay the challenge and retry with the
payment header.

#### ERR: PAYMENT_INVALID
The submitted payment did not validate. Rebuild it from a fresh \`402\`
challenge.

#### ERR: INSUFFICIENT_FUNDS
Not enough USDC (or ALGO for fees). Fund the wallet — see
[Wallet and funding](#wallet-and-funding).

#### ERR: NOT_OPTED_IN
The account has not opted in to the USDC asset. Opt in to the \`/meta\` asset id.

#### ERR: PAYMENT_UNAVAILABLE
The payment facilitator is temporarily unavailable. Retry after a short wait.

#### ERR: PAYMENT_IN_FLIGHT
A payment for this claim is already settling. Wait and re-check status.

#### ERR: OPTIN_INVALID
The submitted opt-in transaction is malformed. Rebuild it.

#### ERR: DEPENDENCY_UNAVAILABLE
An upstream dependency is down. Retry later.

#### ERR: GAME_NOT_FOUND
Unknown game id, or a replay requested for a non-terminal game. There is no
existence signal for non-terminal games by design.

#### ERR: PAUSED
The service is paused (see \`/meta.status\`). Retry once it resumes.

#### ERR: NOT_FOUND
Unknown route or a cloaked admin route. Check the OpenAPI document.

#### ERR: INTERNAL
Unexpected server error; the body carries a \`requestId\`. Retry; if it
persists, report the \`requestId\`.

#### ERR: BUDGET_EXCEEDED
*(client-side)* Your agent-kit spend budget would be exceeded. Raise the budget
or stop. The server never emits this code.

## Interactive play

When you play on behalf of a human:

- Render the returned position for them — the claim FEN, or \`?include=ascii\`
  for a board you can print directly.
- Map their SAN, UCI, or natural-language intent onto one of the returned
  \`legalMoves\` before submitting; reject anything not in that list.
- **Confirm before you pay.** A staked move spends real USDC and cannot be
  undone; show the stake and get explicit confirmation before answering the
  \`402\` challenge.
`;

export function registerLlmsRoute(app: Hono<AppEnv>): void {
  app.get("/llms.txt", (c) =>
    c.body(LLMS_TXT, 200, { "Content-Type": "text/markdown; charset=utf-8" }),
  );
}
