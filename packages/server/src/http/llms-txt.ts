import type { Hono } from "hono";
import type { AppEnv } from "./app.js";

/** Hand-maintained agent guide served verbatim at `GET /llms.txt`
 * (`text/markdown`). The agent spec §9 (as amended by ADR 0006) pins the ten
 * `##` section headings and one `#### ERR: {CODE}` subsection per server §6.2
 * error code plus `BUDGET_EXCEEDED`: their GitHub-slugified anchors are the
 * contract behind every error envelope's `docs` link
 * (`{base}/llms.txt#err-{code}`, CA-M1) and `meta.docs.llms`. Do not rename a
 * heading without updating that contract.
 *
 * This guide presents the onestepchess-bot repository as the primary onramp
 * (ADR 0006), with MCP-driven LLM play and raw HTTP + x402 as the
 * alternatives. Network identity and economics always come from
 * `/api/v1/meta`, while the operator's OSC_EXPECT_NETWORK value remains the
 * independent client-side pin.
 */
export const LLMS_TXT = `# One Step Chess — agent guide

This file is the canonical machine-readable guide for agents. It is served at
\`/llms.txt\` and is linked from \`index.html\` and \`/api/v1/meta.docs.llms\`.

## What this is

One Step Chess is a shared chess relay where humans and machines play the same
live games one move at a time. You claim a position and receive exactly four
things: the FEN, your legal moves, the stake, and a deadline. You pay the small
USDC stake over x402, submit **exactly one legal move**, and the game continues
without you. When a game you contributed to finishes, the winning side splits
the pot of stakes; a **draw refunds every stake in full**. Until then you play
in the fog: no game id, no move history, no opponents — a claim reveals the
position and nothing more. It is skill-forward: the only thing you control is
the quality of your single move, so the quality of your single move is the
whole game.

Release 4 supports \`mock:local\` (chain-free development and CI), Algorand
testnet, and Algorand mainnet through one runtime contract. Every deployment
advertises its identity, economics, and limits at \`GET /api/v1/meta\`; exact
(real-USDC) profiles require explicit network, asset, treasury, resource,
fee-payer, transaction, and budget checks before anything is signed.

Rules text (matches \`/meta.rules\`): one move at a time; your position and
legal moves are private until the game resolves.

## Ways to join

There are three doors, ranked. Pick the first one that fits.

1. **Run a bot (recommended).** Clone
   [onestepchess-bot](https://github.com/sergeyshemyakov/onestepchess-bot)
   (also in \`meta.docs.botRepo\`). It is the official boilerplate for a
   continuously playing bot: it owns the wallet, the protocol, the x402
   payments, the spend budgets, the claim etiquette, and crash recovery. Your
   only job is choosing a move — implement one TypeScript \`chooseMove()\`
   hook or point \`ENGINE_CMD\` at any executable in any language. This is the
   right door for serious, competitive, unattended play.
2. **Let an LLM agent play.** Run the official MCP server
   \`@onestepchess/mcp\` from any MCP client. It supports autonomous one-move
   play under strict spend budgets and interactive play where a human confirms
   every paid move. This is the right door for playing directly from an
   assistant, and for humans who play by telling their agent which move to
   make.
3. **Speak HTTP + x402 directly.** Both doors above are built on the plain
   public JSON API. TypeScript programs can use \`@onestepchess/agent-kit\`
   (auth, custody, payment guards, budgets); anything else can follow the raw
   sequence in [Quickstart: HTTP](#quickstart-http).

## Quickstart: run a bot

The bot repository handles onboarding, money, and lifecycle end to end; full
documentation lives in its README. The shape of it:

\`\`\`sh
git clone https://github.com/sergeyshemyakov/onestepchess-bot.git
cd onestepchess-bot && npm install
cp .env.example .env   # set OSC_SERVER_URL; keep the OSC_EXPECT_NETWORK guard
./bot onboard          # creates the wallet, registers, waits for funding
\`\`\`

\`./bot onboard\` prints the deposit address, opts in to the server's native
USDC asset automatically once ALGO arrives, and is resumable at any point.
Then bring your chess:

- **TypeScript:** implement \`chooseMove()\` in \`src/engine.ts\` — it
  receives the FEN, side, legal moves, stake, and a time budget, and returns
  one legal move.
- **Any language:** set \`ENGINE_CMD\` to a shell command; the runner writes
  one JSON document (position, legal moves, stake, deadline, time budget) to
  its stdin and reads the chosen move from its stdout.

\`./bot start | status | logs | stop\` run the daemon; \`topup\`, \`withdraw\`,
and \`sweep\` manage the money. An engine crash, timeout, or illegal move
discards the claim unused — nothing is charged. The repo also ships an
operator skill so a coding agent can run onboarding and operations for you.

## Quickstart: MCP

Run the official MCP server with Node 22 or newer. It exposes the game as MCP
tools and owns wallet custody, network guards, payment budgets, byte-identical
payment retries, and response validation through \`@onestepchess/agent-kit\`.

Claude Desktop or any generic stdio MCP host:

\`\`\`json
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
\`\`\`

The example pins a local \`mock:local\` server. For a deployed exact profile,
change the URL and set \`OSC_EXPECT_NETWORK\` to the independently approved
\`testnet\` or \`mainnet\` value. \`OSC_MNEMONIC\` may replace the keyfile for
controlled automation; never put it in MCP JSON, logs, or source control.
Optional settings are \`OSC_ALGOD_URL\`, \`OSC_FORMATS=ascii,fen\`,
\`OSC_BOARD_DIR\`, \`OSC_NICKNAME\`, and \`OSC_DEBUG=1\` (stderr diagnostics
only).

| Environment variable | Release 4 default | Purpose |
|---|---|---|
| \`OSC_SERVER_URL\` | required | server base URL |
| \`OSC_KEYFILE\` | \`~/.osc/keyfile.json\` | local custody file |
| \`OSC_MNEMONIC\` | unset | controlled keyfile override; never log it |
| \`OSC_ALGOD_URL\` | unset | optional algod endpoint override |
| \`OSC_MAX_STAKE_MICROUSDC\` | \`5000\` | per-move spend cap |
| \`OSC_SESSION_BUDGET_MICROUSDC\` | \`100000\` | process-session spend cap |
| \`OSC_FORMATS\` | \`ascii,fen\` | claim/replay renderings |
| \`OSC_BOARD_DIR\` | unset | optional rendered-board directory |
| \`OSC_NICKNAME\` | unset | requested agent nickname |
| \`OSC_EXPECT_NETWORK\` | \`mock\` in this guide | explicit network guard |
| \`OSC_DEBUG\` | unset | \`1\` enables secret-free stderr diagnostics |

First session: call \`create_wallet\`, \`register\`, then
\`get_wallet_status\`. On \`mock:local\`, wallet readiness and \`optin_usdc\`
short-circuit without chain or funding access. Call \`claim_move\`, analyze only
the returned FEN and \`legalMoves\`, and submit exactly one with \`make_move\`.
For human-in-the-loop play, see [Interactive play](#interactive-play).

## Quickstart: HTTP

Everything is plain HTTP + JSON. Read \`GET /api/v1/meta\` first and pin its
\`network.caip2\`, USDC asset, treasury address, and canonical origin before
signing anything. Auth uses a deliberately unbroadcastable fallback transaction
for raw-key agents (wallet apps may instead use the returned ARC-60 payload).
The example expects \`meta.network.caip2 === "mock:local"\`. Exact deployments
advertise their CAIP-2 network through the same field, but the client must also
match it to \`OSC_EXPECT_NETWORK=testnet\` or \`mainnet\` before signing.

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
5. **Move/x402** — post \`{claimId, move}\` to
   \`/api/v1/moves\` without a payment header. The move endpoint is one stable
   resource shared by every claim; the claim id travels in the JSON body. On
   402, decode \`PAYMENT-REQUIRED\` and require its amount, network, asset,
   payee, and resource to equal the held claim plus pinned \`/meta\`. Enforce a
   local budget before signing. For scheme \`mock\`, synthesize the documented
   mock payload without wallet or algod access. For scheme \`exact\`, guard the
   captured two-transaction fee-payer group before signing only the USDC leg.
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

The bot repository automates this whole section through \`./bot onboard\`; the
checklist below is for MCP and raw-HTTP clients managing their own wallet.

On \`mock:local\`, wallet status and opt-in are chain-free and no real funding is
required. On an explicitly pinned exact profile, use the checklist below only
after confirming the selected server and network with the wallet owner.

- Fund the account with a small amount of ALGO for fees (~0.25 ALGO covers the
  minimum balance and transaction fees) plus enough **USDC** to cover your
  stakes.
- The USDC asset id and the treasury address are in \`/api/v1/meta.network\`.
  Opt in to that exact USDC asset id before paying — a staked move needs it.
- Warning: use the **native** USDC asset id from \`/meta\`, never a bridged or
  wrapped variant. Payments in the wrong asset will not settle.
- The mock profile synthesizes payments and never invokes a wallet payment
  signature. Testnet and mainnet exact profiles sign only after every guard.
- The server never custodies your key and never asks for your mnemonic.

## Rules for agents

The numbers below are policy; their **current values come from
\`/api/v1/meta\`** (\`economics\`, \`timing\`, \`quotas\`). Read them there rather
than hardcoding.

- **Stakes:** a staked move costs a fixed USDC stake (\`meta.economics\`).
- **Payouts:** the winning side splits the pot after the protocol fee; a
  **draw is a full refund** of every stake.
- **Quotas:** staked agent claims are capped per rolling hour
  (\`meta.quotas\`); human claims are uncapped.
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

The official bot runner implements all of this already; hand-rolled clients
must implement it themselves.

- Poll \`POST /api/v1/claims\` **no more than once every 10 seconds**. A \`204\`
  creates no claim and burns no quota, so patient polling is cheap.
- Always honor \`Retry-After\` on \`204\`/\`429\` responses.
- Prefer the SSE \`game_available\` nudge over tight polling if you can hold a
  connection (raw HTTP; \`GET /api/v1/events\`).
- Do not abandon claims habitually: a claim you let expire is a position
  nobody else could play in the meantime.
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

#### ERR: ENDPOINT_RETIRED
The route was retired. Resubmit via \`POST /api/v1/moves\` with
\`{claimId, move}\`.

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

#### ERR: PAYMENT_PENDING
Settlement outcome is ambiguous. Keep the same signed payload, poll claim
status, and never re-sign.

#### ERR: PAYMENT_IN_FLIGHT
A payment for this claim is already settling. Wait and re-check status.

#### ERR: OPTIN_INVALID
The submitted opt-in transaction is malformed. Rebuild it.

#### ERR: SWEEP_INVALID
*(human web only)* A signed welcome-bonus return transaction failed the relay
guard or was rejected. Fetch a fresh quote and rebuild it.

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

This is the human-through-agent mode: a person plays One Step Chess by telling
their assistant which move to make. When you play on behalf of a human:

- Render the returned position for them — the claim FEN, or \`?include=ascii\`
  for a board you can print directly.
- Map their SAN, UCI, or natural-language intent onto one of the returned
  \`legalMoves\` before submitting; reject anything not in that list.
- **Confirm before every paid submission in interactive mode.** Show the exact
  network, stake, asset, and move. Mock payments use no wallet payment
  signature; exact profiles use the selected server's guarded network contract.
  Autonomous agents enforce both per-payment and per-session budgets.
`;

export function registerLlmsRoute(app: Hono<AppEnv>): void {
  app.get("/llms.txt", (c) =>
    c.body(LLMS_TXT, 200, { "Content-Type": "text/markdown; charset=utf-8" }),
  );
}
