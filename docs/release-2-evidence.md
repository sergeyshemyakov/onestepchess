# Release 2 verification evidence

Release 2 combines automated repository gates with checks that require the
final HTTPS mock-staging deployment and physical wallet apps. This file keeps
those two kinds of evidence separate so a local mock result cannot be mistaken
for wallet or production-network certification.

## Automated gate

| Gate | Status | Evidence |
|---|---|---|
| SSE fan-out, reconnect, reset rehydration, claim bar | Local passed | `sse_fanout_maps_every_event_to_its_human_surface`, `sse_reconnect_and_reset_rehydrate_all_rest_state`, `claim_bar_follows_open_claim_across_every_route` |
| Public route chunks and effect cleanup | Local passed | `public_routes_exclude_wallet_and_admin_chunks`, `web_effects_idle_and_cleanup_without_orphaned_work` |
| Release 2 human Playwright journey and edge path | Local passed | `release2_human_happy_path`, `release2_human_edge_matrix` |
| 420/768 browser captures | Local passed | Playwright attachments from `release2_mobile_snapshots_420_and_768` |
| Fresh/migrated mock DB, backup, persistent path, discovery | Local passed | `mock_beta_boots_from_release1_database_with_persistent_paths` |
| Repository lint, typecheck, test, build | Local passed | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` |
| Docker image fresh boot and restart | Blocked locally | `pnpm test:docker` could not connect because the Docker daemon was not running; attach staging output and image digest before certification |

## HTTPS mock-staging gate

Record these only against the final image running with `RAIL=mock`, a
persistent database/backup volume, an HTTPS `PUBLIC_BASE_URL`, and the visible
`mock beta — no real USDC` banner.

| Check | Status | Evidence to record |
|---|---|---|
| Fresh boot and migrated Release 1 boot | Pending staging | Image digest, migration logs, `/healthz` responses |
| Persistent restart and backup creation | Pending staging | Volume id, before/after game row, backup filename and timestamp |
| HTTPS and static headers | Pending staging | HSTS, CSP, cache-control, content-encoding response headers |
| Lighthouse accessibility ≥95 | Pending staging | Landing, authenticated hub, and cold replay reports; reduced-motion and keyboard notes |
| Cold public replay | Pending staging | Network trace proving one public replay request and no session, wallet, or admin request |

## Identity-wallet certification

Every row uses a real wallet only for the authentication challenge. The move
after login must use `rail-mock`; the tester must explicitly record that no
payment approval or payment signature was requested.

| Client | Wallet | Status | Evidence |
|---|---|---|---|
| iOS Safari | Pera | Pending device | Date, app/browser versions, identity method, no-payment confirmation |
| Android Chrome | Pera | Pending device | Date, app/browser versions, identity method, no-payment confirmation |
| Android Chrome | Defly | Pending device | Date, app/browser versions, identity method, no-payment confirmation |
| Desktop Chrome | Lute | Pending device | Date, extension/browser versions, ARC-60 result, no-payment confirmation |
| Desktop Firefox | Pera WalletConnect | Pending device | Date, app/browser versions, fallback result, no-payment confirmation |

No testnet or mainnet transaction belongs in this evidence. Do not paste
mnemonics, JWTs, Turnstile secrets, WalletConnect identifiers, signed auth
transactions, or payment headers.
