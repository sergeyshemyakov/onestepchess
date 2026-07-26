import {
  BudgetGuard,
  type ClaimStatusView,
  type ClaimView,
  createOscClient,
  decodePaymentRequired,
  type FinishedGameItem,
  type MoveReceipt,
  type OngoingGameItem,
  type OscClient,
  type Page,
  type Profile,
  type ReplayView,
  type Signer,
} from "@onestepchess/agent-kit";
import algosdk from "algosdk";

export type PublicFetch = typeof globalThis.fetch;

export type PublicAgentDriver = {
  readonly address: string;
  readonly budget: BudgetGuard;
  readonly client: OscClient;
  register(): Promise<Profile>;
  claim(): Promise<ClaimView | null>;
  play(claim: ClaimView, move?: string): Promise<MoveReceipt>;
  currentClaim(): Promise<ClaimView | null>;
  claimStatus(claimId: string): Promise<ClaimStatusView>;
  games(
    status: "ongoing" | "finished",
  ): Promise<Page<OngoingGameItem | FinishedGameItem>>;
  replay(gameId: string): Promise<ReplayView>;
  restart(): PublicAgentDriver;
  reconnect(fetch: PublicFetch): PublicAgentDriver;
};

type AgentDriverOptions = {
  readonly serverUrl: string;
  readonly fetch: PublicFetch;
  readonly nickname: string;
  readonly account?: algosdk.Account;
  readonly maxStakeMicroUsdc?: number;
  readonly sessionBudgetMicroUsdc?: number;
  readonly nonce?: () => string;
};

function accountSigner(account: algosdk.Account): Signer {
  return {
    address: account.addr.toString(),
    sign(bytes) {
      return algosdk.decodeUnsignedTransaction(bytes).signTxn(account.sk);
    },
  };
}

export function createPublicAgentDriver(
  options: AgentDriverOptions,
): PublicAgentDriver {
  const account = options.account ?? algosdk.generateAccount();
  const budget = new BudgetGuard({
    maxStakeMicroUsdc: options.maxStakeMicroUsdc ?? 5_000,
    sessionBudgetMicroUsdc: options.sessionBudgetMicroUsdc ?? 100_000,
  });
  const client = createOscClient({
    serverUrl: options.serverUrl,
    fetch: options.fetch,
    signer: accountSigner(account),
    nickname: options.nickname,
    budget,
    expectNetwork: "mock",
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });

  return Object.freeze({
    address: account.addr.toString(),
    budget,
    client,
    register: () => client.register(options.nickname),
    async claim() {
      const result = await client.claim();
      return "claim" in result ? null : result;
    },
    play(claim, move = claim.legalMoves[0]?.uci ?? "") {
      if (move.length === 0) throw new Error("claim has no legal move");
      return client.move(claim.claimId, move);
    },
    currentClaim: () => client.currentClaim(),
    claimStatus: (claimId) => client.claimStatus(claimId),
    games: (status) => client.myGames({ status }),
    replay: (gameId) => client.replay(gameId),
    restart: () =>
      createPublicAgentDriver({
        ...options,
        account,
      }),
    reconnect: (fetch) =>
      createPublicAgentDriver({
        ...options,
        fetch,
        account,
      }),
  });
}

export type PublicHumanDriver = {
  readonly address: string;
  register(): Promise<Profile>;
  claim(): Promise<ClaimView | null>;
  play(claim: ClaimView, move?: string): Promise<MoveReceipt>;
  currentClaim(): Promise<ClaimView | null>;
  claimStatus(claimId: string): Promise<ClaimStatusView>;
  games(
    status: "ongoing" | "finished",
  ): Promise<Page<OngoingGameItem | FinishedGameItem>>;
};

type HumanDriverOptions = {
  readonly serverUrl: string;
  readonly fetch: PublicFetch;
  readonly nickname: string;
  readonly turnstileToken: string;
  readonly account?: algosdk.Account;
  readonly nonce?: () => string;
};

export function createPublicHumanDriver(
  options: HumanDriverOptions,
): PublicHumanDriver {
  const account = options.account ?? algosdk.generateAccount();
  const address = account.addr.toString();
  const base = `${options.serverUrl.replace(/\/+$/, "")}/api/v1`;
  let token: string | undefined;
  let nextNonce = 1;

  const request = async (
    path: string,
    init: {
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
    } = {},
  ): Promise<Response> =>
    options.fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  const expectJson = async <T>(
    response: Response,
    expectedStatus = 200,
  ): Promise<T> => {
    if (response.status !== expectedStatus) {
      throw new Error(
        `public human request returned ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  };

  const register = async (): Promise<Profile> => {
    const challenge = await expectJson<{ readonly fallbackTxnB64: string }>(
      await request("/auth/challenge", {
        method: "POST",
        body: { address },
      }),
    );
    const transaction = algosdk.decodeUnsignedTransaction(
      new Uint8Array(Buffer.from(challenge.fallbackTxnB64, "base64")),
    );
    const verified = await expectJson<{ readonly jwt: string }>(
      await request("/auth/verify", {
        method: "POST",
        body: {
          address,
          method: "txn",
          signedTxnB64: Buffer.from(transaction.signTxn(account.sk)).toString(
            "base64",
          ),
          kind: "human",
          nickname: options.nickname,
          turnstileToken: options.turnstileToken,
        },
      }),
    );
    token = verified.jwt;
    return expectJson<Profile>(await request("/my/profile"));
  };

  const claim = async (): Promise<ClaimView | null> => {
    const response = await request("/claims", {
      method: "POST",
      body: { demo: false },
    });
    if (response.status === 204) return null;
    const body = await expectJson<{ readonly claim: ClaimView }>(
      response,
      response.status,
    );
    return body.claim;
  };

  return Object.freeze({
    address,
    register,
    claim,
    async play(claimView, move = claimView.legalMoves[0]?.uci ?? "") {
      if (move.length === 0) throw new Error("claim has no legal move");
      const path = `/claims/${encodeURIComponent(claimView.claimId)}/move`;
      const challengeResponse = await request(path, {
        method: "POST",
        body: { move },
      });
      if (challengeResponse.status !== 402) {
        throw new Error(
          `public human move challenge returned ${challengeResponse.status}`,
        );
      }
      const encoded = challengeResponse.headers.get("PAYMENT-REQUIRED");
      if (encoded === null) throw new Error("missing PAYMENT-REQUIRED");
      const paymentRequired = decodePaymentRequired(encoded);
      const accepted = paymentRequired.accepts[0];
      if (accepted === undefined) throw new Error("payment rail missing");
      const nonce =
        options.nonce?.() ?? `human_${String(nextNonce++).padStart(6, "0")}`;
      const payment = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: paymentRequired.resource,
          accepted,
          payload: {
            from: address,
            amountMicroUsdc: Number(accepted.amount),
            asset: accepted.asset,
            payTo: accepted.payTo,
            nonce,
          },
        }),
        "utf8",
      ).toString("base64");
      return expectJson<MoveReceipt>(
        await request(path, {
          method: "POST",
          body: { move },
          headers: { "PAYMENT-SIGNATURE": payment },
        }),
      );
    },
    async currentClaim() {
      const response = await request("/claims/current");
      if (response.status === 404) return null;
      return (await expectJson<{ readonly claim: ClaimView }>(response)).claim;
    },
    async claimStatus(claimId) {
      return expectJson<ClaimStatusView>(
        await request(`/claims/${encodeURIComponent(claimId)}/status`),
      );
    },
    async games(status) {
      return expectJson<Page<OngoingGameItem | FinishedGameItem>>(
        await request(`/my/games?status=${status}&page=1`),
      );
    },
  });
}
