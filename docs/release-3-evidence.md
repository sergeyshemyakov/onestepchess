# Release 3 verification evidence

Release 3 is the agent and operations beta on the offline `mock:local`
profile. No test in this gate contacts a chain, facilitator, testnet, or
mainnet, and no evidence file contains a wallet mnemonic or service secret.

## Automated gate

| Gate | Result | Evidence |
|---|---|---|
| Mixed public clients cross default endspiel and resolve once | Passed | `mixed_public_clients_cross_endspiel_and_resolve_once` |
| Two published agent-kit clients recover and receive payout | Passed | `two_agent_kit_clients_register_claim_play_recover_and_receive_payout` |
| Restart and ambiguous payment recovery | Passed | `public_client_restart_recovers_open_and_ambiguous_claim_without_resigning` |
| Position-only REST/SSE surfaces | Passed | `mixed_game_surfaces_remain_position_only_until_resolution` |
| Live/OpenAPI schema mirror and public-driver import boundary | Passed | `agent_kit_schemas_parse_live_server_and_openapi_examples`, `e2e_driver_has_no_server_core_or_rail_imports` |
| Reduced CI soak/fault matrix | Passed | `release3_soak_finishes_with_zero_invariant_ledger_and_rail_violations`, `release3_soak_faults_recover_across_expiry_ambiguity_sse_and_restart` |
| Persistent restart/migration and backup restore | Passed | `release3_migrates_release2_db_and_recovers_persistent_restart`, `release3_backup_restore_preserves_history_and_ops_state` |
| Admin/SSE/config isolation and secret/copy audit | Passed | `release3_admin_api_sse_and_config_contracts_are_complete_and_isolated`, `release3_artifacts_logs_and_responses_contain_no_secrets_or_unsupported_claims` |
| Operator route rehearsal | Passed | `diagnose_pause_retry_reconcile_resume` |
| Root lint, typecheck, test, build | Passed locally | `pnpm lint`, `pnpm typecheck`, `pnpm test` (96 files / 666 tests), `pnpm build` |
| Final Docker migration/restart/backup drill | Pending final image | Record image digest and command output in the PR |
| Unfamiliar-human operator drill | Pending staging sign-off | Follow `docs/deploy.md`; automated rehearsal is not a substitute |

## Exact 64 × 100 × 10,000 soak

Command:

```bash
pnpm --filter @onestepchess/e2e release3_soak_64x100x10000 \
  ../docs/verification/release3-soak-report.json
```

The 2026-07-26 local run completed in 78.581 seconds with seed `20260726`,
three persistent SQLite/shared-mock-rail restarts, 100 SSE connections opened
and closed, and 137,895 bounded no-board outcomes from same-side/cooldown
churn. The complete machine-readable report is
`docs/verification/release3-soak-report.json`.

| Measurement | Result |
|---|---:|
| Accepted moves | 10,000 |
| Claim latency p50 / p95 | 16.297 / 36.842 ms |
| Read latency p50 / p95 | 0.441 / 0.510 ms |
| Public settle flow p50 / p95 | 164.606 / 246.790 ms |
| Coordinator command p50 / p95 | 0.170 / 0.533 ms |
| Server `MoveSettled` contribution p50 / p95 | 0.587 / 1.445 ms |
| Peak RSS | 1,295,400,960 bytes |
| Final SQLite / WAL | 27,529,216 / 4,297,192 bytes |
| Structured log lines | 189,648 |

All three server budgets passed: claim/read p95 below 50 ms, coordinator p95
below 10 ms, and server move contribution p95 below 100 ms. The public settle
flow is reported separately because it includes the two-request x402 dance,
64-way client queueing, and client recovery work; it is not substituted for
the server-contribution measurement.

The final report recorded zero domain-invariant violations, duplicate client
transaction ids, duplicate payouts, stranded payment intents, stranded payout
jobs, reconciliation drift, malformed structured logs, and secret findings.
Ledger materialization matched the running balances, and the mock rail matched
the reconciled treasury book exactly.

Injected cases all converged: claim expiry, applied and unapplied settlement
ambiguity, prepared-payout rejection, facilitator health loss/recovery,
reconciliation drift from 1,000 to zero micro-USDC, SSE connection churn,
same-side/cooldown churn, and controlled restart.

## Known limitations

- Release 3 is mock-only. Exact testnet/mainnet payment, payout, funding, and
  opt-in activation remain Release 4 work.
- The service is intentionally one process with one SQLite file; this gate
  validates that scale envelope and does not claim horizontal scaling.
- The soak uses in-process HTTP and rail-mock. Public-client and server
  serialization costs are real, while network and external facilitator
  latency are intentionally absent.
- Peak RSS includes the test runner, 100 agent clients, captured latency
  samples, the in-process server, SQLite, and the mock rail. It is not a
  production container memory claim.
- The unfamiliar-human operator usability gate and final Docker image evidence
  remain explicit release-signoff steps rather than being inferred from unit
  tests.
