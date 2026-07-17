// Scripted dev-stack run (#28/#31/#32 test evidence): drives the real
// server exactly like the web client does — challenge → guarded fallback
// signing → verify (register + login), demo claim → move → receipt, staked
// claim → 402 → synthesized §5.4 mock header → receipt with txid.
//
// Usage: pnpm dev (rail-mock stack), then
//   pnpm --filter @onestepchess/web exec tsx scripts/devstack-run.ts

import algosdk from "algosdk";

const BASE = process.env.OSC_SERVER_URL ?? "http://localhost:3000";

type Json = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Json,
    readonly headers: Headers,
  ) {
    super(`${status}: ${JSON.stringify(body)}`);
  }
}

async function api(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    jwt?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Json; headers: Headers }> {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(init.jwt === undefined
        ? {}
        : { authorization: `Bearer ${init.jwt}` }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body =
    response.status === 204
      ? {}
      : ((await response.json().catch(() => ({}))) as Json);
  if (!response.ok && ![202, 204, 402].includes(response.status)) {
    throw new HttpError(response.status, body, response.headers);
  }
  return { status: response.status, body, headers: response.headers };
}

function step(label: string, detail: unknown = ""): void {
  console.log(
    `> ${label}`,
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

async function register(
  nicknameSuffix: string,
): Promise<{ jwt: string; address: string }> {
  const account = algosdk.generateAccount();
  const address = account.addr.toString();
  const challenge = await api("/auth/challenge", {
    method: "POST",
    body: { address },
  });
  const nonce = challenge.body.nonce as string;
  const fallbackB64 = challenge.body.fallbackTxnB64 as string;

  // The same pre-sign guard the web runs (auth/guards.ts semantics).
  const txn = algosdk.decodeUnsignedTransaction(
    Buffer.from(fallbackB64, "base64"),
  );
  if (
    txn.sender.toString() !== address ||
    txn.payment?.receiver.toString() !== address ||
    txn.payment.amount !== 0n ||
    txn.fee !== 0n ||
    new TextDecoder().decode(txn.note ?? new Uint8Array()) !==
      `osc-auth:${nonce}` ||
    txn.firstValid !== 1n ||
    txn.lastValid !== 1n
  ) {
    throw new Error(
      "fallback txn failed the pinned field guard — refusing to sign",
    );
  }
  step("fallback txn passed the pre-sign guard");
  const signed = Buffer.from(txn.signTxn(account.sk)).toString("base64");

  const verify = await api("/auth/verify", {
    method: "POST",
    body: {
      address,
      method: "txn",
      signedTxnB64: signed,
      kind: "human",
      nickname: `devrun-${nicknameSuffix}`,
      turnstileToken: "dev-fixture-token",
    },
  });
  step("registered + logged in", verify.body.player);
  return { jwt: verify.body.jwt as string, address };
}

async function claim(jwt: string, demo: boolean): Promise<Json> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await api("/claims", {
      method: "POST",
      body: { demo },
      jwt,
    });
    if (result.status === 200 || result.status === 201) {
      return result.body.claim as Json;
    }
    const wait = Number(result.headers.get("Retry-After") ?? 2);
    step(`no boards (204) — retrying in ${wait}s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1_000));
  }
  throw new Error("no board became available");
}

async function main(): Promise<void> {
  const meta = await api("/meta");
  step("meta", {
    caip2: (meta.body.network as Json).caip2,
    mode: (meta.body.status as Json).mode,
  });

  // --- demo path ---
  const human1 = await register(`d${Date.now() % 100000}`);
  const demoClaim = await claim(human1.jwt, true);
  step("demo claim", {
    claimId: demoClaim.claimId,
    side: demoClaim.yourSide,
    stake: demoClaim.stakeMicroUsdc,
  });
  const demoMove = (demoClaim.legalMoves as Json[])[0] as Json;
  const demoReceipt = await api(`/claims/${demoClaim.claimId}/move`, {
    method: "POST",
    body: { move: demoMove.uci },
    jwt: human1.jwt,
  });
  if (demoReceipt.status !== 200) throw new Error("demo move did not settle");
  step("demo receipt", demoReceipt.body);
  if ((demoReceipt.body.txid ?? null) !== null) {
    throw new Error("demo receipt unexpectedly carries a txid");
  }

  // --- staked path (mock x402) ---
  const human2 = await register(`s${Date.now() % 100000}`);
  const stakedClaim = await claim(human2.jwt, false);
  step("staked claim", {
    claimId: stakedClaim.claimId,
    stake: stakedClaim.stakeMicroUsdc,
  });
  const stakedMove = (stakedClaim.legalMoves as Json[])[0] as Json;
  const first = await api(`/claims/${stakedClaim.claimId}/move`, {
    method: "POST",
    body: { move: stakedMove.uci },
    jwt: human2.jwt,
  });
  if (first.status !== 402)
    throw new Error(`expected 402, got ${first.status}`);
  const challengeHeader = first.headers.get("PAYMENT-REQUIRED");
  if (challengeHeader === null)
    throw new Error("402 carried no PAYMENT-REQUIRED");
  const required = JSON.parse(
    Buffer.from(challengeHeader, "base64").toString("utf8"),
  );
  const requirement = required.accepts[0];
  step("402 challenge", requirement);
  if (requirement.scheme !== "mock")
    throw new Error("expected the mock scheme");
  if (requirement.amount !== String(stakedClaim.stakeMicroUsdc)) {
    throw new Error("challenge amount != claim stake");
  }

  // Synthesize the rail §5.4 payload exactly like wallet/x402.ts.
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: required.resource,
      accepted: requirement,
      payload: {
        from: human2.address,
        amountMicroUsdc: Number(requirement.amount),
        asset: requirement.asset,
        payTo: requirement.payTo,
        nonce: `devrun-${crypto.randomUUID()}`,
      },
    }),
  ).toString("base64");
  const settled = await api(`/claims/${stakedClaim.claimId}/move`, {
    method: "POST",
    body: { move: stakedMove.uci },
    jwt: human2.jwt,
    headers: { "PAYMENT-SIGNATURE": header },
  });
  if (settled.status !== 200) {
    throw new Error(
      `staked settle failed: ${settled.status} ${JSON.stringify(settled.body)}`,
    );
  }
  step("staked receipt", settled.body);
  if (typeof settled.body.txid !== "string") {
    throw new Error("staked receipt carries no txid");
  }
  if (typeof settled.body.explorerUrl !== "string") {
    throw new Error("staked receipt carries no explorer link");
  }

  // Idempotent replay: same header returns the original receipt.
  const replay = await api(`/claims/${stakedClaim.claimId}/move`, {
    method: "POST",
    body: { move: stakedMove.uci },
    jwt: human2.jwt,
    headers: { "PAYMENT-SIGNATURE": header },
  });
  if (replay.status !== 200 || replay.body.txid !== settled.body.txid) {
    throw new Error("idempotent replay did not return the original receipt");
  }
  step("idempotent replay ok — same txid", replay.body.txid);

  console.log("\nDEV-STACK RUN PASSED ✔");
}

main().catch((error) => {
  console.error("DEV-STACK RUN FAILED ✘", error);
  process.exit(1);
});
