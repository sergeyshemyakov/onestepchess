# Release 2 T1 chain-smoke evidence

The reusable AVM slice is covered offline by `@onestepchess/rail-avm` and
the web exact-challenge fixture test. Real-chain evidence is intentionally
human-triggered and never runs in CI.

## Testnet run

The original T1 command and environment contract were superseded by the
Release 4 fail-closed harness in
[`release-4.md`](release-4.md). `smoke:t1` now aliases that harness so the old
implementation cannot persist signed payout bytes. Follow the Release 4
variable table and evidence rules for any new run.

Use a dedicated testnet treasury and payer with free testnet USDC. Put the
profile only in an untracked environment file; never paste mnemonics into a
command, terminal transcript, artifact, or this document.

The current variables, consent gate, and command are documented only in the
Release 4 verification guide. The old `T1_*` environment contract is no longer
accepted.

Historical note: the original artifact design included persistable signed
payout bytes. The Release 4 replacement records only public transaction ids,
rounds, timing, and prepared identity; signed payment and treasury payloads are
never written to evidence.

Status for issue #52: offline contracts implemented; real testnet run not
performed in this agent session because no separate chain-smoke approval was
given. The live run must confirm the pinned wire contract or trigger a spec
revision plus a numbered ADR before T1 is declared passed.
