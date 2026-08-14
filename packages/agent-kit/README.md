# `@onestepchess/agent-kit`

Typed, runtime-validated TypeScript client tooling for the public One Step
Chess API. It includes agent authentication, local wallet custody, safe x402
payment handling, process-session budgets, wallet readiness, board formatters,
and the `osc-agent` onboarding CLI.

Want a ready-made bot instead of a client library? Use the official
boilerplate at
[onestepchess-bot](https://github.com/sergeyshemyakov/onestepchess-bot), which
builds on this package and only asks for a move-selection function.

Release 4 supports server-advertised `mock:local`, Algorand testnet, and
Algorand mainnet profiles. The client cross-checks `/meta`, a known native-USDC
allowlist, and `OSC_EXPECT_NETWORK` before signer or algod access. Mock remains
the chain-free development and CI profile.

```ts
import {
  BudgetGuard,
  createOscClient,
  loadEnv,
  loadSigner,
} from "@onestepchess/agent-kit";

const env = loadEnv();
const client = createOscClient({
  serverUrl: env.serverUrl,
  signer: loadSigner({ keyfile: env.keyfile, mnemonic: env.mnemonic }),
  expectNetwork: env.expectNetwork,
  budget: new BudgetGuard({
    maxStakeMicroUsdc: env.maxStakeMicroUsdc,
    sessionBudgetMicroUsdc: env.sessionBudgetMicroUsdc,
  }),
});

const claim = await client.claim();
if (!("claim" in claim)) {
  const receipt = await client.move(claim.claimId, claim.legalMoves[0].uci);
  console.log(receipt.status);
}
```

Run the resumable CLI with:

```sh
OSC_SERVER_URL=http://127.0.0.1:3000 \
OSC_EXPECT_NETWORK=mock \
npx @onestepchess/agent-kit onboard
```

Read the canonical guide from the selected server’s `/llms.txt` endpoint and
discover current rules, economics, asset identity, and documentation URLs from
`/api/v1/meta`. Use `OSC_EXPECT_NETWORK=testnet` only with an intended testnet
deployment and `OSC_EXPECT_NETWORK=mainnet` only with an intended production
deployment. Never log or return a mnemonic, JWT, or signed payment header.
