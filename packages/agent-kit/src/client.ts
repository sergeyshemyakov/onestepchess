import { z } from "zod";
import { type Signer, signAuthChallenge } from "./auth.js";
import { BudgetGuard } from "./budget.js";
import { OscApiError, OscClientError } from "./errors.js";
import { writeClaimFiles, writeReplayFiles } from "./format/registry.js";
import {
  type ClaimStatusView,
  type ClaimView,
  challengeResponseSchema,
  claimStatusViewSchema,
  claimViewSchema,
  deriveOutcome,
  errorEnvelopeSchema,
  type FinishedGameItem,
  finishedGameItemSchema,
  type Meta,
  type MoveReceipt,
  metaSchema,
  moveReceiptSchema,
  type OngoingGameItem,
  ongoingGameItemSchema,
  type Page,
  type Profile,
  pageSchema,
  profileSchema,
  type ReplayView,
  replayViewSchema,
  verifyResponseSchema,
} from "./schemas.js";
import {
  assertTrustedPayment,
  buildPaymentHeader,
  type CachedPayment,
  decodePaymentRequired,
  decodePaymentResponse,
  PaymentCache,
} from "./x402.js";

const claimEnvelopeSchema = z.object({ claim: claimViewSchema });
const profilePatchSchema = z.object({
  player: z.object({
    address: z.string(),
    kind: z.enum(["human", "agent"]),
    nickname: z.string().nullable(),
    createdAt: z.string(),
  }),
});

export type OscClientOptions = {
  readonly serverUrl: string;
  readonly signer?: Signer;
  readonly nickname?: string;
  readonly budget?: BudgetGuard;
  readonly expectNetwork?: "mainnet" | "testnet" | "mock";
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly moveTimeoutMs?: number;
  readonly algodUrl?: string;
  readonly boardDir?: string;
  readonly nonce?: () => string;
};

export type ClaimResult =
  | ClaimView
  | { readonly claim: null; readonly retryAfterSeconds: number };

export interface OscClient {
  meta(): Promise<Meta>;
  register(nickname?: string): Promise<Profile>;
  whoami(): Promise<Profile>;
  profile(options?: { includeBalances?: boolean }): Promise<Profile>;
  setNickname(nickname: string): Promise<Profile>;
  claim(): Promise<ClaimResult>;
  currentClaim(): Promise<ClaimView | null>;
  claimStatus(claimId: string): Promise<ClaimStatusView>;
  move(claimId: string, move: string): Promise<MoveReceipt>;
  myGames(query: {
    status: "ongoing" | "finished";
    page?: number;
  }): Promise<Page<OngoingGameItem | FinishedGameItem>>;
  replay(gameId: string): Promise<ReplayView>;
  logout(): Promise<void>;
}

export function retryAfterSecondsFrom(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function decodeOscApiError(
  response: Response,
): Promise<OscApiError> {
  let envelope: z.infer<typeof errorEnvelopeSchema>;
  try {
    envelope = errorEnvelopeSchema.parse(await response.json());
  } catch {
    envelope = {
      error: "INTERNAL",
      hint: `unexpected response (${response.status})`,
      docs: "",
    };
  }
  const retryAfterSeconds = retryAfterSecondsFrom(response.headers);
  return new OscApiError({
    code: envelope.error,
    hint: envelope.hint,
    docs: envelope.docs,
    status: response.status,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(envelope.legalMoves === undefined
      ? {}
      : { legalMoves: envelope.legalMoves }),
    ...(envelope.suggestion === undefined
      ? {}
      : { suggestion: envelope.suggestion }),
    ...(envelope.requestId === undefined
      ? {}
      : { requestId: envelope.requestId }),
  });
}

function expiredError(): OscApiError {
  return new OscApiError({
    code: "CLAIM_EXPIRED",
    hint: "claim expired; nothing was charged",
    docs: "",
    status: 410,
  });
}

export function createOscClient(options: OscClientOptions): OscClient {
  const serverUrl = options.serverUrl.replace(/\/+$/, "");
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const moveTimeoutMs = options.moveTimeoutMs ?? 120_000;
  const budget = options.budget ?? new BudgetGuard();
  const paymentCache = new PaymentCache();
  const claims = new Map<string, ClaimView>();
  let jwt: string | undefined;
  let metaPromise: Promise<Meta> | undefined;
  let authPromise: Promise<void> | undefined;

  const url = (path: string) => `${serverUrl}/api/v1${path}`;

  function paymentSigner(): Signer {
    if (options.signer !== undefined) return options.signer;
    throw new OscClientError(
      "NO_WALLET",
      "a signer is required for a staked move",
    );
  }

  async function buildCachedPayment(
    claim: ClaimView,
    challengeHeader: string,
    resourceUrl: string,
  ): Promise<CachedPayment> {
    const paymentRequired = decodePaymentRequired(challengeHeader);
    const meta = await getMeta();
    const requirement = assertTrustedPayment({
      paymentRequired,
      claim,
      meta,
      resourceUrl,
      ...(options.expectNetwork === undefined
        ? {}
        : { expectNetwork: options.expectNetwork }),
    });
    const algodUrl = options.algodUrl ?? meta.network.algodUrl;
    const headerBytes = await buildPaymentHeader({
      paymentRequired,
      requirement,
      signer: paymentSigner(),
      ...(algodUrl === undefined ? {} : { algodUrl }),
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });
    const payment = {
      claimId: claim.claimId,
      headerBytes,
      amountMicroUsdc: claim.stakeMicroUsdc,
    };
    paymentCache.set(payment);
    return payment;
  }

  async function execute(
    path: string,
    init: {
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
      readonly timeoutMs?: number;
      readonly token?: string;
    } = {},
  ): Promise<Response> {
    return fetchFn(url(path), {
      method: init.method ?? "GET",
      headers: {
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.token === undefined
          ? {}
          : { authorization: `Bearer ${init.token}` }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? requestTimeoutMs),
    });
  }

  async function parse<T>(
    response: Response,
    schema: z.ZodType<T>,
    endpoint: string,
  ): Promise<T> {
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(`${endpoint} response was not valid JSON`);
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `${endpoint} response failed wire validation: ${z.prettifyError(result.error)}`,
      );
    }
    return result.data;
  }

  async function getMeta(): Promise<Meta> {
    if (metaPromise === undefined) {
      const pending = (async () => {
        const response = await execute("/meta");
        if (!response.ok) throw await decodeOscApiError(response);
        return parse(response, metaSchema, "GET /meta");
      })();
      // Cache meta for the client's lifetime once it resolves, but drop a
      // rejected fetch so a transient failure does not permanently brick every
      // later meta/auth/move call (mirrors how authenticate() clears its
      // in-flight promise on settle).
      pending.catch(() => {
        if (metaPromise === pending) metaPromise = undefined;
      });
      metaPromise = pending;
    }
    return metaPromise;
  }

  async function authenticate(nickname = options.nickname): Promise<void> {
    const signer = options.signer;
    if (signer === undefined) {
      throw new OscClientError(
        "NO_WALLET",
        "authentication requires a wallet; create one or set OSC_MNEMONIC",
      );
    }
    if (authPromise !== undefined) return authPromise;
    authPromise = (async () => {
      const challengeResponse = await execute("/auth/challenge", {
        method: "POST",
        body: { address: signer.address },
      });
      if (!challengeResponse.ok) {
        throw await decodeOscApiError(challengeResponse);
      }
      const challenge = await parse(
        challengeResponse,
        challengeResponseSchema,
        "POST /auth/challenge",
      );
      const signedTxnB64 = signAuthChallenge({
        challenge,
        meta: await getMeta(),
        signer,
      });
      const verifyResponse = await execute("/auth/verify", {
        method: "POST",
        body: {
          address: signer.address,
          method: "txn",
          signedTxnB64,
          kind: "agent",
          ...(nickname === undefined ? {} : { nickname }),
        },
      });
      if (!verifyResponse.ok) {
        throw await decodeOscApiError(verifyResponse);
      }
      const verified = await parse(
        verifyResponse,
        verifyResponseSchema,
        "POST /auth/verify",
      );
      jwt = verified.jwt;
    })().finally(() => {
      authPromise = undefined;
    });
    return authPromise;
  }

  async function request(
    path: string,
    init: {
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
      readonly timeoutMs?: number;
      readonly auth?: boolean;
    } = {},
  ): Promise<Response> {
    if (init.auth !== false && jwt === undefined) await authenticate();
    const call = () =>
      execute(path, {
        ...init,
        ...(init.auth === false || jwt === undefined ? {} : { token: jwt }),
      });
    let response = await call();
    if (init.auth === false || response.status !== 401) return response;
    const candidate = await decodeOscApiError(response.clone());
    if (candidate.code !== "UNAUTHENTICATED") return response;
    jwt = undefined;
    await authenticate();
    response = await call();
    return response;
  }

  async function checked(
    path: string,
    init?: Parameters<typeof request>[1],
  ): Promise<Response> {
    const response = await request(path, init);
    if (!response.ok) throw await decodeOscApiError(response);
    return response;
  }

  async function getProfile(includeBalances = false): Promise<Profile> {
    const suffix = includeBalances ? "?include=balances" : "";
    return parse(
      await checked(`/my/profile${suffix}`),
      profileSchema,
      "GET /my/profile",
    );
  }

  async function statusForRecovery(claimId: string) {
    const response = await checked(
      `/claims/${encodeURIComponent(claimId)}/status`,
    );
    const status = await parse(
      response,
      claimStatusViewSchema,
      "GET /claims/:id/status",
    );
    if (status.status === "open") claims.set(claimId, status.claim);
    return status;
  }

  async function finishReceipt(
    response: Response,
    claimId: string,
    paid: boolean,
  ): Promise<MoveReceipt> {
    const receipt = await parse(
      response,
      moveReceiptSchema,
      "POST /claims/:id/move",
    );
    if (paid) {
      const header = response.headers.get("PAYMENT-RESPONSE");
      if (header === null) {
        throw new Error(
          "POST /claims/:id/move response omitted PAYMENT-RESPONSE",
        );
      }
      const settlement = decodePaymentResponse(header);
      const network = (await getMeta()).network.caip2;
      if (
        settlement.network !== network ||
        settlement.transaction !== receipt.txid
      ) {
        throw new OscClientError(
          "NETWORK_MISMATCH",
          "PAYMENT-RESPONSE does not match the move receipt",
        );
      }
    }
    paymentCache.delete(claimId);
    claims.delete(claimId);
    return receipt;
  }

  async function recoverAfterAmbiguity(
    claimId: string,
  ): Promise<MoveReceipt | "resend" | "inflight"> {
    const status = await statusForRecovery(claimId);
    if (status.status === "moved") {
      paymentCache.delete(claimId);
      claims.delete(claimId);
      return status.receipt;
    }
    if (status.status === "expired") {
      paymentCache.delete(claimId);
      budget.release(claimId);
      throw expiredError();
    }
    return status.paymentState === null ? "resend" : "inflight";
  }

  function inflightRecoveryError(
    paymentState: "verifying" | "settling" | null,
  ): OscApiError {
    const state = paymentState === null ? "no longer in flight" : paymentState;
    return new OscApiError({
      code: "PAYMENT_IN_FLIGHT",
      hint: `the previous payment is ${state}; poll claim status and never construct a fresh payment until it is definitively open`,
      docs: "",
      status: 409,
      retryAfterSeconds: 5,
    });
  }

  async function move(claimId: string, moveText: string): Promise<MoveReceipt> {
    let claim = claims.get(claimId);
    if (claim === undefined) {
      const status = await statusForRecovery(claimId);
      if (status.status === "moved") return status.receipt;
      if (status.status === "expired") throw expiredError();
      if (status.paymentState !== null) {
        throw inflightRecoveryError(status.paymentState);
      }
      claim = status.claim;
    }

    const path = `/claims/${encodeURIComponent(claimId)}/move`;
    const resourceUrl = url(path);
    let cached = paymentCache.get(claimId);
    let rebuilds = 0;
    let resends = 0;

    while (true) {
      let response: Response;
      try {
        response = await request(path, {
          method: "POST",
          body: { move: moveText },
          timeoutMs: moveTimeoutMs,
          ...(cached === undefined
            ? {}
            : { headers: { "PAYMENT-SIGNATURE": cached.headerBytes } }),
        });
      } catch (error) {
        if (cached === undefined) throw error;
        const recovered = await recoverAfterAmbiguity(claimId);
        if (recovered !== "resend" && recovered !== "inflight") {
          return recovered;
        }
        if (resends >= 1) throw error;
        resends += 1;
        continue;
      }

      if (response.status === 200) {
        return finishReceipt(response, claimId, cached !== undefined);
      }
      if (response.status === 202) {
        const recovered = await recoverAfterAmbiguity(claimId);
        if (recovered !== "resend" && recovered !== "inflight") {
          return recovered;
        }
        throw new OscApiError({
          code: "PAYMENT_PENDING",
          hint: "payment settlement is pending; poll claim status and never re-sign",
          docs: "",
          status: 202,
          retryAfterSeconds: retryAfterSecondsFrom(response.headers) ?? 5,
        });
      }

      const error = await decodeOscApiError(response.clone());
      const challengeHeader = response.headers.get("PAYMENT-REQUIRED");
      if (cached === undefined && error.code === "PAYMENT_REQUIRED") {
        if (challengeHeader === null) throw error;
        budget.reserve(claimId, claim.stakeMicroUsdc);
        try {
          cached = await buildCachedPayment(
            claim,
            challengeHeader,
            resourceUrl,
          );
          continue;
        } catch (buildError) {
          budget.release(claimId);
          throw buildError;
        }
      }

      if (error.code === "PAYMENT_INVALID" && rebuilds < 1) {
        if (challengeHeader === null) {
          paymentCache.delete(claimId);
          budget.release(claimId);
          throw error;
        }
        rebuilds += 1;
        paymentCache.delete(claimId);
        cached = undefined;
        budget.reserve(claimId, claim.stakeMicroUsdc);
        try {
          cached = await buildCachedPayment(
            claim,
            challengeHeader,
            resourceUrl,
          );
        } catch (buildError) {
          budget.release(claimId);
          throw buildError;
        }
        continue;
      }

      if (error.code === "PAYMENT_IN_FLIGHT") {
        if (cached !== undefined) {
          if (resends < 1) {
            resends += 1;
            continue;
          }
        } else {
          const status = await statusForRecovery(claimId);
          if (status.status === "moved") return status.receipt;
          if (status.status === "expired") throw expiredError();
          throw inflightRecoveryError(status.paymentState);
        }
      }

      if (
        error.code === "INSUFFICIENT_FUNDS" ||
        error.code === "NOT_OPTED_IN" ||
        error.code === "PAYMENT_UNAVAILABLE" ||
        error.code === "CLAIM_EXPIRED" ||
        error.code === "PAYMENT_INVALID"
      ) {
        paymentCache.delete(claimId);
        budget.release(claimId);
      }
      throw error;
    }
  }

  return Object.freeze({
    meta: getMeta,

    async register(nickname?: string): Promise<Profile> {
      if (jwt === undefined) await authenticate(nickname);
      let profile = await getProfile();
      if (nickname !== undefined && profile.nickname !== nickname) {
        profile = await this.setNickname(nickname);
      }
      return profile;
    },

    whoami: () => getProfile(),

    profile: (input?: { includeBalances?: boolean }) =>
      getProfile(input?.includeBalances === true),

    async setNickname(nickname: string): Promise<Profile> {
      const response = await checked("/my/profile", {
        method: "PATCH",
        body: { nickname },
      });
      await parse(response, profilePatchSchema, "PATCH /my/profile");
      return getProfile();
    },

    async claim(): Promise<ClaimResult> {
      const response = await request("/claims", {
        method: "POST",
        body: {},
      });
      if (response.status === 204) {
        return {
          claim: null,
          retryAfterSeconds: retryAfterSecondsFrom(response.headers) ?? 5,
        };
      }
      if (!response.ok) throw await decodeOscApiError(response);
      const result = await parse(response, claimEnvelopeSchema, "POST /claims");
      claims.set(result.claim.claimId, result.claim);
      if (options.boardDir !== undefined) {
        writeClaimFiles(result.claim, options.boardDir);
      }
      return result.claim;
    },

    async currentClaim(): Promise<ClaimView | null> {
      const response = await request("/claims/current");
      if (!response.ok) {
        const error = await decodeOscApiError(response);
        if (error.code === "NO_OPEN_CLAIM") return null;
        throw error;
      }
      const result = await parse(
        response,
        claimEnvelopeSchema,
        "GET /claims/current",
      );
      claims.set(result.claim.claimId, result.claim);
      if (options.boardDir !== undefined) {
        writeClaimFiles(result.claim, options.boardDir);
      }
      return result.claim;
    },

    claimStatus: statusForRecovery,
    move,

    async myGames(query: {
      status: "ongoing" | "finished";
      page?: number;
    }): Promise<Page<OngoingGameItem | FinishedGameItem>> {
      const page = query.page ?? 1;
      const path = `/my/games?status=${query.status}&page=${page}`;
      if (query.status === "ongoing") {
        return parse(
          await checked(path),
          pageSchema(ongoingGameItemSchema),
          "GET /my/games?status=ongoing",
        );
      }
      const parsed = await parse(
        await checked(path),
        pageSchema(finishedGameItemSchema),
        "GET /my/games?status=finished",
      );
      return {
        ...parsed,
        items: parsed.items.map((item) => ({
          ...item,
          outcome: deriveOutcome(item),
        })),
      };
    },

    async replay(gameId: string): Promise<ReplayView> {
      const result = await parse(
        await checked(`/games/${encodeURIComponent(gameId)}/replay`, {
          auth: false,
        }),
        replayViewSchema,
        "GET /games/:id/replay",
      );
      if (options.boardDir !== undefined) {
        writeReplayFiles(result, options.boardDir);
      }
      return result;
    },

    async logout(): Promise<void> {
      const response = await request("/auth/logout", { method: "POST" });
      if (response.status !== 204) {
        throw await decodeOscApiError(response);
      }
      jwt = undefined;
    },
  });
}
