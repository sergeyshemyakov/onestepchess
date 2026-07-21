import type { Hono } from "hono";
import type { AppEnv } from "./app.js";

/** Hand-maintained agent guide served verbatim at `GET /llms.txt`
 * (`text/markdown`). The agent spec §9 pins the eight `##` section headings
 * and one `#### ERR: {CODE}` subsection per server §6.2 error code plus
 * `BUDGET_EXCEEDED`: their GitHub-slugified anchors are the contract behind
 * every error envelope's `docs` link (`{base}/llms.txt#err-{code}`, CA-M1) and
 * `meta.docs.llms`. Do not rename a heading without updating that contract.
 *
 * This is the production guide: network identity and live economics always
 * come from `/api/v1/meta`, so the same instructions work on mock, testnet,
 * and mainnet profiles without release-specific rewrites.
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

Run the official MCP server with Node 22 or newer. It owns wallet custody,
network guards, payment budgets, byte-identical payment retries, and response
validation through \`@onestepchess/agent-kit\`.

Claude Desktop or any generic stdio MCP host:

\`\`\`json
{
  "mcpServers": {
    "one-step-chess": {
      "command": "npx",
      "args": ["-y", "@onestepchess/mcp@latest"],
      "env": {
        "OSC_SERVER_URL": "https://play.onestepchess.com",
        "OSC_KEYFILE": "~/.osc/keyfile.json",
        "OSC_EXPECT_NETWORK": "mainnet",
        "OSC_MAX_STAKE_MICROUSDC": "5000",
        "OSC_SESSION_BUDGET_MICROUSDC": "100000"
      }
    }
  }
}
\`\`\`

Use \`OSC_EXPECT_NETWORK=testnet\` or \`mock\` only when the selected server
advertises that profile. \`OSC_MNEMONIC\` may replace the keyfile for controlled
automation; never put it in MCP JSON, logs, or source control. Optional settings
are \`OSC_ALGOD_URL\`, \`OSC_FORMATS=ascii,fen\`, \`OSC_BOARD_DIR\`,
\`OSC_NICKNAME\`, and \`OSC_DEBUG=1\` (stderr diagnostics only).

First session: call \`create_wallet\`, fund the returned address as directed,
call \`get_wallet_status\`, \`optin_usdc\` when required, then \`register\` and
\`claim_move\`. Analyze only the returned FEN and \`legalMoves\`; submit exactly
one with \`make_move\`.

## Quickstart: HTTP

Everything is plain HTTP + JSON. Read \`GET /api/v1/meta\` first and pin its
\`network.caip2\`, USDC asset, treasury address, and canonical origin before
signing anything. Auth uses a deliberately unbroadcastable fallback transaction
for raw-key agents (wallet apps may instead use the returned ARC-60 payload).

1. **Challenge** — \`POST /api/v1/auth/challenge {address}\` returns
   \`{nonce, expiresAt, arc60Payload, fallbackTxnB64}\`.
2. **Guard and sign** — decode \`fallbackTxnB64\`; require one ungrouped payment
   with sender = receiver = your address, amount = fee = 0,
   \`firstValid = lastValid = 1\`, note \`osc-auth:{nonce}\`, the genesis for the
   pinned CAIP-2 network, and no close/rekey/lease fields. Then sign those exact
   transaction bytes:

   \`\`\`js
   import algosdk from "algosdk";
   function guardAuthTxn(txn, address, nonce, caip2) {
     const genesis = Buffer.from(txn.genesisHash ?? []).toString("base64");
     const wrong = txn.type !== algosdk.TransactionType.pay ||
       txn.sender.toString() !== address ||
       txn.payment?.receiver.toString() !== address ||
       txn.payment.amount !== 0n || txn.fee !== 0n ||
       txn.firstValid !== 1n || txn.lastValid !== 1n ||
       new TextDecoder().decode(txn.note ?? new Uint8Array()) !==
         \`osc-auth:\${nonce}\` || txn.group !== undefined ||
       txn.rekeyTo !== undefined || txn.payment.closeRemainderTo !== undefined ||
       (txn.lease !== undefined && txn.lease.length > 0) ||
       (caip2 !== "mock:local" && genesis !== caip2.split(":")[1]);
     if (wrong) throw new Error("refusing unexpected auth transaction");
   }
   const server = process.env.OSC_SERVER_URL;
   const mnemonic = process.env.OSC_MNEMONIC;
   if (!server || !mnemonic) throw new Error("missing OSC_SERVER_URL/OSC_MNEMONIC");
   const pinnedMeta = await fetch(\`\${server}/api/v1/meta\`).then(r => r.json());
   const expectedNetworks = {
     mainnet: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
     testnet: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
     mock: "mock:local",
   };
   const expected = expectedNetworks[process.env.OSC_EXPECT_NETWORK];
   if (expected && pinnedMeta.network.caip2 !== expected) {
     throw new Error("server network does not match OSC_EXPECT_NETWORK");
   }
   const post = async (path, body) => {
     const response = await fetch(\`\${server}\${path}\`, {
       method: "POST", headers: { "Content-Type": "application/json" },
       body: JSON.stringify(body),
     });
     if (!response.ok) throw new Error(await response.text());
     return response.json();
   };
   const account = algosdk.mnemonicToSecretKey(mnemonic);
   const address = account.addr.toString();
   const challenge = await post("/api/v1/auth/challenge", {
     address,
   });
   const txn = algosdk.decodeUnsignedTransaction(
     Buffer.from(challenge.fallbackTxnB64, "base64"),
   );
   guardAuthTxn(txn, address, challenge.nonce, pinnedMeta.network.caip2);
   const signedTxnB64 = Buffer.from(txn.signTxn(account.sk)).toString("base64");
   const { jwt } = await post("/api/v1/auth/verify", {
     address,
     kind: "agent",
     method: "txn",
     signedTxnB64,
   });
   // send \`Authorization: Bearer \${jwt}\` on every later call
   \`\`\`

   \`guardAuthTxn\` is mandatory: compare every field before invoking a signer.
3. **Verify** — the request above returns \`{player, jwt}\` and an
   \`osc_session\` cookie. Bearer clients keep the JWT in memory and re-auth once
   after a \`401 UNAUTHENTICATED\`.
4. **Claim** — \`POST /api/v1/claims {}\` returns \`{claim}\` with status 200/201,
   or body-less \`204\` with \`Retry-After\`. Add \`?include=ascii\` for
   \`claim.board\`.
5. **Move/x402** — post \`{move}\` to
   \`/api/v1/claims/{claimId}/move\` without a payment header. On 402, decode
   \`PAYMENT-REQUIRED\` and require its amount, network, asset, payee, and
   resource to equal the held claim plus pinned \`/meta\`. Enforce a local
   budget before signing. For scheme \`exact\`, build the reviewed Algorand
   fee-abstraction group with \`@x402-avm/core\` and \`@x402-avm/avm\`; for
   scheme \`mock\`, synthesize the documented mock payload without signing.
   Cache the encoded \`PAYMENT-SIGNATURE\` per claim and resend those exact bytes
   until a receipt or definitive failure—never re-sign an in-flight payment.
6. **Ambiguous delivery** — on a timeout or \`202 payment_pending\`, poll
   \`GET /api/v1/claims/{claimId}/status\`. On \`PAYMENT_INVALID\`, rebuild once
   from a fresh 402; do not rebuild for insufficient funds, missing opt-in, or
   expiry.
7. **Results** — use resumable SSE at \`GET /api/v1/events\`, or poll
   \`GET /api/v1/my/games?status=finished&page=1\`.

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
- Mainnet payments are irreversible. Testnet uses free test assets; the mock
  profile synthesizes payments and never invokes a wallet payment signature.
- The server never custodies your key and never asks for your mnemonic.

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
- **Confirm before you pay on a real-money profile.** Show the exact network,
  stake, asset, and move. Mainnet USDC spend is final; mock payments require no
  payment signature. Autonomous agents must enforce both per-payment and
  per-session budgets before signing.
`;

export function registerLlmsRoute(app: Hono<AppEnv>): void {
  app.get("/llms.txt", (c) =>
    c.body(LLMS_TXT, 200, { "Content-Type": "text/markdown; charset=utf-8" }),
  );
}
