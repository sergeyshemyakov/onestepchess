# Release 4 verification

Release 4 live evidence is intentionally separate from CI. The repository's
default tests use `rail-mock`; neither live command belongs in a workflow,
scheduled job, or routine pre-PR check.

Both commands use one `OSC_LIVE_*` environment shape. Required pins are
`OSC_LIVE_PROFILE`, `OSC_LIVE_EXPECT_NETWORK`, `OSC_LIVE_CAIP2`,
`OSC_LIVE_USDC_ASA_ID`, `OSC_LIVE_ALGOD_URL`, `OSC_LIVE_INDEXER_URL`,
`OSC_LIVE_FACILITATOR_URL`, `OSC_LIVE_TREASURY_ADDRESS`,
`OSC_LIVE_EXPECT_FEE_PAYER`, `OSC_LIVE_PAYER_ADDRESS`, and the canonical
`OSC_LIVE_RESOURCE_URL`. Amounts are
`OSC_LIVE_PAYMENT_MICRO_USDC`, `OSC_LIVE_PAYOUT_MICRO_USDC`, and
`OSC_LIVE_AGGREGATE_BUDGET_MICRO_USDC`. Credentials are supplied only through
the untracked `OSC_LIVE_TREASURY_MNEMONIC` and `OSC_LIVE_PAYER_MNEMONIC`
variables. `OSC_LIVE_APPROVED=yes` and a fresh
`OSC_LIVE_EVIDENCE_PATH` are mandatory. Mainnet additionally requires a fresh
`OSC_LIVE_MAINNET_LOCK_PATH`.

## Offline implementation evidence

- `release4_chain_harness_uses_one_env_shaped_flow_for_testnet_and_mainnet`
  proves one orchestration sequence with profile values substituted.
- `release4_live_chain_commands_refuse_ci_missing_consent_wrong_network_and_unsafe_budget`
  proves every live preflight fails before signer or rail construction.
- `captured_release4_shapes_roundtrip_through_rail_web_and_agent_guards`
  exercises the public V2 shapes without committing signed bytes.
- `release4_money_crash_matrix_converges_without_duplicate_move_payout_or_bonus`
  preserves mock idempotency across reconstructed rail instances.
- `mainnet_parity_command_allows_exactly_the_pinned_micro_smoke_once` pins the
  operation list, fresh lock, interactive acknowledgement, and 100,000 µUSDC
  aggregate ceiling.

## 4A — testnet release candidate

Status: **pending an explicit live-testnet run**.

Use a fresh ignored evidence destination, dedicated testnet database and
treasury, and an untracked environment file. The live chain slice runs with:

```sh
pnpm --filter @onestepchess/e2e smoke:release4:testnet
```

The complete application drill must additionally record Pera, Defly, and Lute
auth/payment; agent-kit payment; starter-stake ALGO, opt-in, and USDC legs;
payout; admin pause/recovery; all four forced-crash boundaries; clean
reconciliation; backup/restore; and the green Release 3 public-client,
mixed-endspiel, soak, chaos, and web suites. Assemble only public txids,
rounds, timings, and SHA-256 digests into the strict
`testnet_release_candidate_completes_payments_payouts_bonus_recovery_and_reconciliation`
evidence contract, then validate it with:

```sh
pnpm --filter @onestepchess/e2e verify:release4:evidence -- <evidence.json>
```

Never include a mnemonic, JWT, signed transaction, payment header, prepared
payload, or raw log in committed evidence.

## 4B — mainnet parity

Status: **blocked until a new, separate human approval is supplied after 4A
review**. This implementation does not constitute that approval.

The command requires an interactive terminal, the exact acknowledgement shown
by the prompt, a production-shaped profile, a fresh evidence path, a fresh
one-time lock path, and an aggregate payment-plus-payout budget no greater than
100,000 µUSDC:

```sh
pnpm --filter @onestepchess/e2e smoke:release4:mainnet
```

It performs only supported-network health, one exact payment, one prepared
payout, confirmation/note lookup, and balance reconciliation. It cannot invoke
starter stakes, a bot fleet, or public-traffic enablement. Validate the final
`human_approved_mainnet_micro_smoke_matches_testnet_contracts_and_reconciles_cleanly`
record with the same evidence verifier.
