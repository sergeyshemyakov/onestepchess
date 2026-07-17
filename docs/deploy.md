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
