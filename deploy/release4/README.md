# Release 4 promotion gate

This directory documents the fail-closed 4A → 4B → 4C promotion workflow
from issue [#106](https://github.com/sergeyshemyakov/onestepchess/issues/106).
It does not authorize a testnet run, another mainnet smoke, treasury funding,
or public production traffic.

The verifier accepts one strict JSON promotion manifest. The manifest records
checksums and versioned secret-manager references only; it must never contain
credentials, mnemonic words, JWTs, signed transactions, or x402 payment
headers. Keep the filled manifest and its evidence bundle outside the repo
under a `*.release4-promotion.json` name.

## 1. Build one artifact

Build the Docker image once with the final public WalletConnect project id:

```sh
docker build \
  --build-arg VITE_WALLETCONNECT_PROJECT_ID=<public-project-id> \
  --tag onestepchess:release4 .
```

Record the immutable image digest, web artifact SHA-256, source commit, image
manifest digest, and scan counts. The Docker build has no rail/network build
argument. `RAIL`, the network block, database path, and all secrets are
runtime-only inputs, so this exact artifact is used for testnet and mainnet.
Source maps are not published; the scan still records a zero-file source-map
pass. Scan the image manifest, every extracted layer, web chunks, static
assets, environment metadata, logs, OpenAPI, metrics, and admin output.

## 2. Prepare isolated profiles

Start from `deploy/profiles/testnet.env.example` and
`deploy/profiles/mainnet.env.example`, but put real values only in the
deployment platform. The promotion manifest records versioned secret-manager
references, not values. Testnet and mainnet must have distinct:

- CAIP-2 and USDC asset identities;
- treasury addresses and every secret reference;
- database files and backup directories;
- public, algod, indexer, and explorer origins.

The mainnet database must be fresh, have no imported money history, and pin
its rail/network/asset/treasury identity before recovery. Mainnet ingress
stays closed through validation and the operator drill.

## 3. Assemble all evidence

The manifest is intentionally all-or-nothing. It embeds the strict 4A and 4B
records and requires mock CI/Release 3 regression, OSC Bot, migration, money
safety, artifact, security, operator-drill, treasury, and release-note
sections. A path or checksum alone cannot stand in for omitted evidence.

Run the non-enabling validation at any time:

```sh
pnpm release4:verify-promotion -- \
  /secure/path/release4.release4-promotion.json
```

The mainnet operator drill is performed with public traffic closed. It covers
fresh initialization, restore-before-enable, identity pinning, manual pause,
settled payment recovery, payout and bonus retry, reconciliation, alert
delivery, and rollback. Its evidence is sanitized and checksum-pinned.

The treasury review records only the public address and public balances. It
separates player obligations (unresolved-game refunds and pending/prepared
payouts) from discretionary starter stakes, and proves the ALGO floor and
player obligations are covered. Funding is a deliberate human action; this
workflow never funds or sweeps a wallet.

## 4. Require contemporaneous 4C approval

Immediately before opening ingress, validate the same manifest with:

```sh
pnpm release4:verify-promotion -- \
  /secure/path/release4.release4-promotion.json \
  --require-approved
```

This command fails when the 4C record is withheld, incomplete, contains an
unresolved money-safety defect, or refers to mismatched build/deployment
artifacts. A withheld record must say `publicTraffic: "closed"`. Approval is
still only a gate check: changing platform ingress is a separate human action.

## 5. Enable and rollback

After the approved check, the operator may open ingress without rebuilding
or changing the runtime profile. Record health and alert delivery immediately.
Rollback uses the admin manual-pause control, which stops new claims and new
move attempts while allowing already-settling payments, payout recovery, and
already-submitted bonus recovery to converge. Close ingress if required, but
do not terminate recovery or replace the fresh mainnet database.

No repeated mainnet smoke and no bot-fleet mainnet action is authorized by a
successful promotion record. Either action requires a new explicit request.
