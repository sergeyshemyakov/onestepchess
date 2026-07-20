# Internal mock staging deployment

Release 1 is a private, mock-only playtest. The checked-in `fly.toml` has no
public service or public port: testers connect through the Fly private network
or a local `fly proxy`. Do not allocate a public IP for this release.

## Local image and restart gate

Run the scripted gate from a clean checkout with Docker running:

```bash
pnpm test:docker
```

The script builds the multi-stage image, boots it on an empty named volume,
waits for the container health check, verifies the system banner, writes a
finished-game history marker, restarts the same container, and confirms that
the marker survived. It also checks the image history/config for the
runtime-only JWT fixture. The generated container and volume are removed on
exit; the `onestepchess:release1-smoke` image is retained for inspection.

## Fly.io private staging

Choose an app name and create the app and its volume in the configured region:

```bash
export OSC_FLY_APP=your-private-app-name
fly apps create "$OSC_FLY_APP"
fly volumes create osc_data --app "$OSC_FLY_APP" --region fra --size 1
```

Set deployment plumbing at runtime. Generate a unique JWT value; never put it
in `fly.toml`, shell history, a config file, or the image. `PUBLIC_BASE_URL`
must be the canonical origin that the testers use over the private network.

```bash
read -r -s OSC_JWT_SECRET
fly secrets set --app "$OSC_FLY_APP" \
  JWT_SECRET="$OSC_JWT_SECRET" \
  PUBLIC_BASE_URL="http://${OSC_FLY_APP}.internal:3000"
unset OSC_JWT_SECRET
fly deploy --app "$OSC_FLY_APP"
```

The non-secret staging profile is pinned in `fly.toml`:

| Setting | Value |
|---|---|
| `RAIL` | `mock` |
| `DB_PATH` | `/data/osc.sqlite` on `osc_data` |
| `PORT` | `3000` |
| `SYSTEM_BANNER` | `internal playtest — no real USDC` |

No `TREASURY_MNEMONIC` is used on the mock rail. Confirm `fly ips list --app
"$OSC_FLY_APP"` shows no public address. A tester with Fly private-network
access can use `http://$OSC_FLY_APP.internal:3000`; for a local browser, keep
this proxy running and use `http://localhost:3000` after temporarily setting
`PUBLIC_BASE_URL` to that same origin:

```bash
fly proxy 3000:3000 --app "$OSC_FLY_APP"
```

## Staging evidence

Record the app name/private URL, image digest, deploy timestamp, volume id,
`/healthz` output, `/api/v1/meta.status.banner`, and the final restart-drill
output in `docs/release-1-evidence.md`. Do not paste secret values or signed
payment headers. Re-run the restart drill on the final release commit before
marking the deployment gate complete.

## Release 2 mock-beta profile

The human beta runs the same mock rail as Release 1 (no real USDC, ADR 0001)
but is operated from a single hardened HTTPS origin with discovery, metrics,
and recoverable backups (server spec §§4/6.6, R2-04). It stays profile-neutral:
`RAIL=mock`, no `TREASURY_MNEMONIC`, and no facilitator or chain access.

Set the stable profile at runtime — secrets only via `fly secrets`/env, never
in `fly.toml`, the image, or shell history:

| Setting | Value / source | Notes |
|---|---|---|
| `RAIL` | `mock` | mock rail only; the process refuses to start on `avm` without secrets |
| `DB_PATH` | `/data/osc.sqlite` | on the persistent `osc_data` volume |
| `BACKUP_DIR` | `/data/backups` | persistent volume; defaults to a `backups/` sibling of `DB_PATH` |
| `BACKUP_HOUR_UTC` | `3` (default) | nightly incremental online snapshot |
| `BACKUP_RETENTION_DAYS` | `7` (default) | snapshots pruned to the newest N |
| `PORT` | `3000` | |
| `PUBLIC_BASE_URL` | the canonical **HTTPS** origin | drives cookie `Secure`, HSTS, and `docs`/CSP links |
| `ADMIN_TOKEN` | generated secret | gates `GET /api/v1/metrics`; unset ⇒ endpoint 404s |
| `SYSTEM_BANNER` | `mock beta — no real USDC` | the explicit no-real-money banner, surfaced at `/meta.status.banner` |
| `JWT_SECRET` | generated secret | as Release 1 |
| `ALGOD_URL` | config knob | the CSP `connect-src` algod origin derives from this |
| `WALLETCONNECT_RELAY_URL` | config knob (default `wss://relay.walletconnect.org`) | reviewed exact CSP relay origin |
| `TURNSTILE_SITE_KEY` | config knob | public Turnstile key for the web build |
| `TURNSTILE_SECRET` | env secret | server-side Turnstile verification |

Backup artifacts live on the persistent volume and are never committed
(`backups/` is git-ignored). A failed backup alerts in the logs but does not
pause gameplay.

Discovery and hardening surfaces to verify after deploy:

- `GET /llms.txt` — `text/markdown` production agent guide for the final
  MCP/agent-kit and raw-HTTP contracts; live network/economics remain derived
  from `/api/v1/meta`.
- `GET /api/v1/openapi.json` — generated public API contract; admin routes and
  `/api/v1/metrics` are excluded.
- `GET /api/v1/meta` — `network.caip2 = mock:local`, `status.banner` set.
- Static SPA: hashed assets are immutable and served from precompressed
  `.br`/`.gz` siblings; `index.html` is `no-cache`; responses carry the
  security headers and a config-derived CSP with no `*`/`unsafe-inline`.
- `GET /api/v1/metrics` — 404 without the admin token, JSON counters with
  `Authorization: Bearer $ADMIN_TOKEN`.

The WalletConnect project id and Turnstile keys are public deployment values;
record the exact CSP relay origin from the wallet smoke before allowlisting any
additional origin (server spec §6.6).
