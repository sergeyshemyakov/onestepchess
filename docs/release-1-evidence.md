# Release 1 verification evidence

Release 1 is complete only when every row below has verifiable evidence.
Automated checks may be recorded by the PR/CI; staging and human checks remain
unchecked until a person performs them on the final image.

| Gate | Status | Evidence to record |
|---|---|---|
| Core simulator: ≥1,000 P1 + P2 games, zero invariant violations, <60 s | Local passed; final CI pending | Link the `pnpm test` job and simulator timing |
| Six-identity seven-ply checkmate | Local passed; final CI pending | Link the `release1-gate: seven-ply checkmate settles and resolves once` test |
| Paid-move and payout crash/restart suites | Local passed; final CI pending | Link the recovery and payout-executor test output |
| CI four | Local passed; final CI pending | Link green lint, typecheck, test, and build jobs |
| Empty-DB migrations and local Docker restart | Local passed | Attach `pnpm test:docker` output and image digest |
| Private staging restart with DB/game history intact | Pending staging | Record private URL, volume id, before/after row evidence, and timestamps |
| Desktop and ~420 px human playtest | Pending human testers | Fill one checklist per tester from `docs/playtest.md` |
| Log/secret spot check | Local passed; staging pending | Record structured-log and image history/config inspection; paste no secrets |
| Deferred-feature audit | Pending review | Confirm no wallet-brand dead controls, archive/replay links, or network names |

## Local pre-PR evidence — 2026-07-17

- `pnpm lint`: passed, 191 files checked.
- `pnpm typecheck`: passed.
- `pnpm test`: passed, 61 files and 457 tests.
- `pnpm build`: passed; server/workspace TypeScript and the Vite production
  bundle built successfully.
- Core simulator: seed `20260716`, P1 `113` + P2 `909` completed games,
  `23.9s`, gate passed with zero reported invariant violations.
- Release 1 e2e: `pnpm --filter @onestepchess/e2e test` passed; the named
  seven-ply gate completed in the e2e project.
- Docker: `pnpm test:docker` passed on Docker `28.4.0`; fresh migrations,
  `/healthz`, banner, structured secret-free logs, stop/start finished-game
  history, and runtime-secret image inspection all passed. Local image digest:
  `sha256:23e6ba590a3857afee0f9ab7528c2ff226109dc588a8a67f9f2458d934175e36`.

This local evidence does not complete the private Fly deployment or the
multi-human desktop/mobile checklist. Those rows intentionally remain pending.

## Known Release 1 limitations

- No SSE, archive, replay, guest, referral, points, sharing, championship, or
  other incentive surfaces.
- Humans are excluded from endspiel by the final rules. Endspiel completion is
  proven by the core simulator only until agent clients arrive in Release 3.
- The development wallet provider and fallback authentication transaction are
  for the internal loop. Pera, Defly, Lute, and production Turnstile
  certification are Release 2.
- Settlement and payouts use `rail-mock`; no facilitator, Algorand node,
  testnet, mainnet, or real USDC is contacted.
- The Release 2 Playwright journey, viewport snapshots, Lighthouse evidence,
  HTTPS wallet certification, and technical gate T1 are not Release 1 gates.

## Manual sign-off

Record the final commit SHA and date, then have the release owner sign only
after all pending rows carry evidence.

- Final commit: pending
- Verification date: pending
- Release owner: pending
