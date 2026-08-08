# Running and playtesting Release 1

Release 1 is a local playable alpha. It runs on `rail-mock`: balances,
settlements, and payouts are synthetic, and no facilitator, Algorand node,
testnet, mainnet, or real USDC is contacted. Use disposable development
mnemonics only; never paste a real wallet seed into the playtest provider.

Prerequisites are Node 22, pnpm 10.33, and a modern browser. Docker is needed
only for the image/restart gate.

## The developer loop

```bash
pnpm install
pnpm dev
```

- Server: `http://localhost:3000` (`RAIL` defaults to `mock`).
- Web: the URL Vite prints (default `http://localhost:5173`); its `/api` and
  `/healthz` requests are proxied to the server, so the SPA and API share one
  origin exactly like production.
- Point the proxy elsewhere with `VITE_API_PROXY` (default
  `http://localhost:3000`).

Smoke check both processes:

```bash
curl -s http://localhost:3000/healthz      # {"status":"ok","mode":"running"}
curl -s http://localhost:5173/healthz      # same, via the Vite proxy
```

The four CI checks run topologically across every workspace:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The named Release 1 API gate can also be run by itself:

```bash
pnpm --filter @onestepchess/e2e test
```

It creates six isolated human identities, signs the real fallback auth
transaction with in-test Algorand accounts, and plays a seven-ply paid
checkmate over public HTTP routes. It then checks single settlement,
resolution, ledger conservation, invariants, and payout application.

## The playtest profile

The default config is what CI tests and is left untouched. The playtest overlay
lives in a **separate** file, [`osc.playtest.config.json`](../osc.playtest.config.json)
(deliberately *not* `osc.config.json`, which the server auto-discovers), and is
passed explicitly:

```bash
pnpm dev:playtest
```

`dev:playtest` sets `OSC_CONFIG_PATH="$PWD/osc.playtest.config.json"` (an
absolute path, so it resolves regardless of each workspace's working directory)
and starts the same two processes. The overlay changes only these knobs:

| Knob | Default | Playtest | Why |
|------|---------|----------|-----|
| `GAME_POOL_TARGET` | 8 | 1 | one shared game, so every tester lands on it |
| `MIN_PLY_INTERVAL_SECONDS` | 20 | 3 | moves come around quickly |
| `CLAIM_TTL_HUMAN` | 600 | 120 | a stalled human frees the slot sooner |
| `CLAIM_TTL_ENDSPIEL` | 30 | 15 | endspiel keeps moving |

Every other value is the schema default. Each knob is a core `GameRules` field,
so the value is snapshotted into `games.rules_json` at creation — a game started
under the playtest profile keeps its pacing even if the config later changes.

## Start a shared playtest

Use the one-board profile rather than the normal developer loop:

```bash
pnpm dev:playtest
```

Open the Vite URL and check that the banner says the session is an internal
playtest with no real USDC. If the server and web are on their defaults, these
checks should pass:

```bash
curl -s http://localhost:3000/healthz
curl -s http://localhost:3000/api/v1/meta
```

For the packaged image, private staging, persistent-volume configuration, and
restart drill, follow [`docs/deploy.md`](deploy.md). Record final evidence in
[`docs/release-1-evidence.md`](release-1-evidence.md).

## Create separate test identities

Each player is a wallet address, so distinct testers need distinct sessions.
The simplest way to run several on one machine is isolated browser profiles,
each with its own cookie jar and disposable development wallet:

- **Chrome/Edge:** People → Add, one profile per identity.
- **Firefox:** `about:profiles` → Create a New Profile, or `firefox -P`.
- Or use one normal window per identity plus incognito/private windows (note
  that private windows share state with each other in some browsers — prefer
  full profiles when in doubt).

In each profile:

1. Open the app and choose **I HAVE AN ALGORAND WALLET**.
2. Select **dev wallet (mnemonic)**. Branded wallets are intentionally hidden
   until Release 2 certification.
3. Create or import a different disposable mnemonic. Do not reuse a wallet
   that holds real assets, and do not save mnemonics in the repo, screenshots,
   logs, or the evidence file.
4. Approve the fallback authentication transaction. It is invalid by
   construction and is signed only; it is never broadcast.
5. Pick a nickname and finish registration. The `osc_session` cookie keeps
   that browser profile signed in.

For the seven-ply scripted checkmate, create six identities. The player who
makes ply 1 may make ply 7 after the playtest cooldown; the other five players
each make one intervening ply.

## Play the first release

From the logged-in hub:

1. Choose **PLAY** for a mock-staked move or **DEMO PLAY** for an uncounted,
   zero-stake move.
2. Read the side badge and stake chip. The board deliberately reveals no game
   name, id, ply number, or history.
3. Select a piece, check that only legal targets highlight, then select a
   target. Use the claim timer as the deadline authority shown by the UI.
4. In **CONFIRM**, verify the chosen move and approve it. A mock-staked move
   synthesizes the x402 payload; there is no wallet payment prompt.
5. Wait through **SETTLING** and read **RECEIPT**. A paid receipt shows the
   synthetic debit and transaction link; a demo receipt says nothing was
   staked and the move is not counted.
6. Switch to the next identity and repeat. After a checkmate, resolution and
   payout happen server-side; Release 1 has no archive or finished-game view.

Useful edge checks are refreshing in FOCUS/CONFIRM, letting one claim expire,
and observing NO_BOARDS, QUOTA_OUT, and PAUSED copy when those states are
deliberately induced. Never expect a human claim after the game enters
endspiel: humans are correctly excluded there.

`SYSTEM_BANNER` initializes `/meta.status.banner` at boot and renders at the top
of the SPA. Internal staging sets it to `internal playtest — no real USDC`.

## Manual tester checklist

Run this once on desktop and once at a narrow viewport around 420 px. Copy the
table per tester into the release evidence or PR notes; do not record wallet
addresses or mnemonics.

| Check | Desktop | ~420 px | Notes |
|---|---|---|---|
| Side to move is immediately understandable | ☐ | ☐ | |
| Legal piece and target interaction is understandable | ☐ | ☐ | |
| Stake/demo amount is unambiguous | ☐ | ☐ | |
| Deadline and urgent timer state are understandable | ☐ | ☐ | |
| CONFIRM clearly identifies the chosen move | ☐ | ☐ | |
| RECEIPT clearly explains debit/result | ☐ | ☐ | |
| No game identity, name, ply, or history is visible | ☐ | ☐ | |
| Board is at least 320 px and mobile confirm is usable | n/a | ☐ | |
| Tester completed one demo and one mock-staked move | ☐ | ☐ | |

Record tester alias, browser/version, viewport, final commit SHA, staging image
digest, date, and any confusion. Several humans must complete the checklist on
the final internal Docker staging before the manual gate is signed off.

## Release 1 limitations

- No dev bots — Release 1 games progress by human moves (endspiel completion is
  proven by the core simulator, not live bots).
- No SSE, archive/replay, guest flow, incentives, admin, or finished-game UI.
- No Pera/Defly certification and no production Turnstile certification.
- No testnet/mainnet profile and no real payment or payout.
- Docker is part of the Release 1 gate, but a real private staging deployment
  and human checklist cannot be substituted by local automated tests.
