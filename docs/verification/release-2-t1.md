# Release 2 T1 chain-smoke evidence

The reusable AVM slice is covered offline by `@onestepchess/rail-avm` and
the web exact-challenge fixture test. Real-chain evidence is intentionally
human-triggered and never runs in CI.

## Testnet run

Use a dedicated testnet treasury and payer with free testnet USDC. Put the
profile only in an untracked environment file; never paste mnemonics into a
command, terminal transcript, artifact, or this document.

Required variables are `T1_CAIP2`, `T1_USDC_ASA_ID`, `T1_ALGOD_URL`,
`T1_INDEXER_URL`, `T1_FACILITATOR_URL`, `T1_TREASURY_MNEMONIC`,
`T1_PAYER_MNEMONIC`, `T1_RESOURCE_URL`, `T1_PAYMENT_MICRO_USDC`,
`T1_PAYOUT_MICRO_USDC`, and a new `T1_ARTIFACT_PATH`. The script refuses CI,
requires `OSC_CHAIN_SMOKE_APPROVED=yes`, and creates the artifact rather than
overwriting an existing file.

```sh
set -a
. ./.env.testnet
set +a
pnpm build
OSC_CHAIN_SMOKE_APPROVED=yes pnpm --filter @onestepchess/e2e smoke:t1
```

The artifact contains the V2 challenge and persistable signed payout bytes,
but no mnemonic or payment-signature header. Record the final JSON line and
the artifact hash in the PR after an explicitly approved run.

Status for issue #52: offline contracts implemented; real testnet run not
performed in this agent session because no separate chain-smoke approval was
given. The live run must confirm the pinned wire contract or trigger a spec
revision plus a numbered ADR before T1 is declared passed.
