# Running an internal playtest

One Step Chess runs fully offline in development: `pnpm dev` starts the server
on `rail-mock` (no facilitator, no chain) plus the Vite dev server, which
proxies `/api` and `/healthz` to the server. This is the loop for hacking on the
stack. To have several people (or several browser tabs) act on **one** game
together, use the playtest profile.

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

## Separate identities in one browser

Each player is a wallet address, so distinct testers need distinct sessions. The
simplest way to run several on one machine is isolated browser profiles, each
with its own cookie jar and wallet:

- **Chrome/Edge:** People → Add, one profile per identity.
- **Firefox:** `about:profiles` → Create a New Profile, or `firefox -P`.
- Or use one normal window per identity plus incognito/private windows (note
  that private windows share state with each other in some browsers — prefer
  full profiles when in doubt).

Give each profile its own wallet (or wallet account) and register once; from
then on the `osc_session` cookie keeps that tab acting as that player.

The `/meta.status.banner` field carries any operator banner (set via the admin
surface); it renders at the top of the SPA and is a convenient way to label a
playtest session for participants.

## Not in this loop

- No dev bots — Release 1 games progress by human moves (endspiel completion is
  proven by the core simulator, not live bots).
- `pnpm dev:testnet` and Docker are separate, later tasks.
