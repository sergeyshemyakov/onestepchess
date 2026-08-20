import { z } from "zod";
import {
  ApiError,
  jsonRequestInit,
  parseJson,
  responseError,
  retryAfterSecondsFrom,
} from "./http.js";
import {
  type BonusClaimResponse,
  type BonusSweepQuote,
  type BonusSweepReceipt,
  bonusClaimResponseSchema,
  bonusOptInResponseSchema,
  bonusOptInTxnResponseSchema,
  bonusSweepQuoteSchema,
  bonusSweepResponseSchema,
  type ChallengeResponse,
  type ClaimStatus,
  type ClaimView,
  challengeResponseSchema,
  claimStatusSchema,
  claimViewSchema,
  type ErrorEnvelope,
  type FinishedGameItem,
  finishedGameItemSchema,
  type GamesPage,
  gamesPageSchema,
  type Meta,
  type MoveReceipt,
  metaSchema,
  moveReceiptSchema,
  type OngoingGameItem,
  ongoingGameItemSchema,
  type PlayerView,
  type ProfileView,
  playerSchema,
  profileSchema,
  type ReplayView,
  replayViewSchema,
  type VerifyResponse,
  verifyResponseSchema,
} from "./schemas.js";

export {
  ApiError,
  decodeEnvelope,
  retryAfterSecondsFrom,
} from "./http.js";

const claimEnvelopeSchema = z.object({ claim: claimViewSchema });

export type CreateClaimResult =
  | {
      readonly kind: "claim";
      readonly claim: ClaimView;
      readonly created: boolean;
    }
  | { readonly kind: "none"; readonly retryAfterSeconds: number }
  | { readonly kind: "quota"; readonly retryAfterSeconds: number }
  | { readonly kind: "guest_used"; readonly envelope: ErrorEnvelope }
  | { readonly kind: "turnstile_failed"; readonly envelope: ErrorEnvelope }
  | { readonly kind: "paused" };

export type PostMoveResult =
  | { readonly kind: "receipt"; readonly receipt: MoveReceipt }
  | {
      readonly kind: "payment_required";
      readonly challengeHeader: string;
      readonly envelope: ErrorEnvelope;
    }
  | {
      readonly kind: "payment_failed";
      readonly code: "PAYMENT_INVALID" | "INSUFFICIENT_FUNDS" | "NOT_OPTED_IN";
      readonly envelope: ErrorEnvelope;
      readonly challengeHeader: string | null;
    }
  | { readonly kind: "pending"; readonly retryAfterSeconds: number }
  | { readonly kind: "in_flight" }
  | { readonly kind: "unavailable"; readonly retryAfterSeconds: number }
  | { readonly kind: "expired" }
  | { readonly kind: "paused" }
  | {
      readonly kind: "illegal";
      readonly envelope: ErrorEnvelope;
    };

export type ApiClient = ReturnType<typeof createApiClient>;

export type ApiClientOptions = {
  readonly fetchFn?: typeof fetch;
  /** 401 anywhere (outside login/boot probe) drops the session (§5.1). */
  readonly onUnauthorized?: () => void;
};

export function createApiClient(options: ApiClientOptions = {}) {
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);

  async function request(
    path: string,
    init: {
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
      readonly suppressAuthHook?: boolean;
    } = {},
  ): Promise<Response> {
    const response = await fetchFn(`/api/v1${path}`, jsonRequestInit(init));
    if (!response.ok && response.status !== 204) {
      if (response.status === 401 && init.suppressAuthHook !== true) {
        options.onUnauthorized?.();
      }
      throw await responseError(response);
    }
    return response;
  }

  async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    return parseJson(response, schema);
  }

  return {
    async getMeta(): Promise<Meta> {
      return json(await request("/meta"), metaSchema);
    },

    async authChallenge(address: string): Promise<ChallengeResponse> {
      return json(
        await request("/auth/challenge", { method: "POST", body: { address } }),
        challengeResponseSchema,
      );
    },

    async authVerify(body: Record<string, unknown>): Promise<VerifyResponse> {
      return json(
        await request("/auth/verify", {
          method: "POST",
          body,
          suppressAuthHook: true,
        }),
        verifyResponseSchema,
      );
    },

    async authLogout(): Promise<void> {
      await request("/auth/logout", { method: "POST" });
    },

    async suggestNickname(): Promise<string> {
      const parsed = await json(
        await request("/auth/suggest-nickname"),
        z.object({ nickname: z.string() }),
      );
      return parsed.nickname;
    },

    /** Boot probe: 200 → session in, 401 → out — never the logout hook. */
    async probeProfile(): Promise<PlayerView | null> {
      try {
        return await json(
          await request("/my/profile", { suppressAuthHook: true }),
          playerSchema,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },

    /** Full profile; `balances: true` only ever from the wallet popover
     * (F-W9 — the only surface that requests chain balances). */
    async getProfile(options?: {
      readonly balances?: boolean;
    }): Promise<ProfileView> {
      const suffix = options?.balances === true ? "?include=balances" : "";
      return json(await request(`/my/profile${suffix}`), profileSchema);
    },

    async renameProfile(nickname: string): Promise<PlayerView> {
      const parsed = await json(
        await request("/my/profile", { method: "PATCH", body: { nickname } }),
        z.object({ player: playerSchema }),
      );
      return parsed.player;
    },

    async claimBonus(): Promise<BonusClaimResponse> {
      return json(
        await request("/my/bonus/claim", { method: "POST" }),
        bonusClaimResponseSchema,
      );
    },

    async getBonusOptInTxn(): Promise<string> {
      const parsed = await json(
        await request("/my/bonus/optin-txn"),
        bonusOptInTxnResponseSchema,
      );
      return parsed.unsignedTxnB64;
    },

    async submitBonusOptIn(signedTxnB64: string): Promise<void> {
      await json(
        await request("/my/bonus/optin", {
          method: "POST",
          body: { signedTxnB64 },
        }),
        bonusOptInResponseSchema,
      );
    },

    async getBonusSweepTxns(): Promise<BonusSweepQuote> {
      return json(await request("/my/bonus/sweep-txns"), bonusSweepQuoteSchema);
    },

    async submitBonusSweep(
      signedTxnsB64: readonly string[],
    ): Promise<BonusSweepReceipt> {
      return json(
        await request("/my/bonus/sweep", {
          method: "POST",
          body: { signedTxnsB64: [...signedTxnsB64] },
        }),
        bonusSweepResponseSchema,
      );
    },

    async getOngoingGames(page: number): Promise<GamesPage<OngoingGameItem>> {
      return json(
        await request(`/my/games?status=ongoing&page=${page}`),
        gamesPageSchema(ongoingGameItemSchema),
      );
    },

    async getFinishedGames(page: number): Promise<GamesPage<FinishedGameItem>> {
      return json(
        await request(`/my/games?status=finished&page=${page}`),
        gamesPageSchema(finishedGameItemSchema),
      );
    },

    /** Public — no cookie needed; 404 (unknown or non-terminal) surfaces as
     * an ApiError for the NotFound page. Callers go through the replay
     * cache (§5.1), not this method directly. */
    async getReplay(gameId: string): Promise<ReplayView> {
      return json(await request(`/games/${gameId}/replay`), replayViewSchema);
    },

    async createClaim(body: {
      demo?: boolean;
      turnstileToken?: string;
      ref?: string;
    }): Promise<CreateClaimResult> {
      try {
        const response = await request("/claims", { method: "POST", body });
        if (response.status === 204) {
          return {
            kind: "none",
            retryAfterSeconds: retryAfterSecondsFrom(response.headers) ?? 5,
          };
        }
        const parsed = await json(response, claimEnvelopeSchema);
        return {
          kind: "claim",
          claim: parsed.claim,
          created: response.status === 201,
        };
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === "QUOTA_OUT") {
            return {
              kind: "quota",
              retryAfterSeconds: error.retryAfterSeconds ?? 60,
            };
          }
          if (error.code === "PAUSED") return { kind: "paused" };
          if (error.code === "GUEST_DEMO_USED") {
            return { kind: "guest_used", envelope: error.envelope };
          }
          if (
            error.code === "TURNSTILE_FAILED" ||
            error.code === "TURNSTILE_REQUIRED"
          ) {
            return { kind: "turnstile_failed", envelope: error.envelope };
          }
        }
        throw error;
      }
    },

    async getCurrentClaim(options?: {
      readonly anonymous?: boolean;
    }): Promise<ClaimView | null> {
      try {
        const response = await request("/claims/current", {
          suppressAuthHook: options?.anonymous === true,
        });
        return (await json(response, claimEnvelopeSchema)).claim;
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.code === "NO_OPEN_CLAIM" ||
            (options?.anonymous === true && error.status === 401))
        ) {
          return null;
        }
        throw error;
      }
    },

    async getClaimStatus(
      id: string,
      options?: { readonly anonymous?: boolean },
    ): Promise<ClaimStatus | null> {
      try {
        return await json(
          await request(`/claims/${id}/status`, {
            suppressAuthHook: options?.anonymous === true,
          }),
          claimStatusSchema,
        );
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.code === "CLAIM_NOT_FOUND" ||
            error.code === "NOT_YOUR_CLAIM" ||
            (options?.anonymous === true && error.status === 401))
        ) {
          return null;
        }
        throw error;
      }
    },

    async postMove(
      claimId: string,
      move: string,
      paymentHeader?: string,
    ): Promise<PostMoveResult> {
      try {
        const response = await request("/moves", {
          method: "POST",
          body: { claimId, move },
          headers:
            paymentHeader === undefined
              ? {}
              : { "PAYMENT-SIGNATURE": paymentHeader },
        });
        if (response.status === 202) {
          return {
            kind: "pending",
            retryAfterSeconds: retryAfterSecondsFrom(response.headers) ?? 5,
          };
        }
        return {
          kind: "receipt",
          receipt: await json(response, moveReceiptSchema),
        };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const challengeHeader = error.headers.get("PAYMENT-REQUIRED");
        switch (error.code) {
          case "PAYMENT_REQUIRED":
            if (challengeHeader === null) throw error;
            return {
              kind: "payment_required",
              challengeHeader,
              envelope: error.envelope,
            };
          case "PAYMENT_INVALID":
          case "INSUFFICIENT_FUNDS":
          case "NOT_OPTED_IN":
            return {
              kind: "payment_failed",
              code: error.code,
              envelope: error.envelope,
              challengeHeader,
            };
          case "PAYMENT_UNAVAILABLE":
            return {
              kind: "unavailable",
              retryAfterSeconds: error.retryAfterSeconds ?? 5,
            };
          case "PAYMENT_IN_FLIGHT":
            return { kind: "in_flight" };
          case "CLAIM_EXPIRED":
            return { kind: "expired" };
          case "PAUSED":
            return { kind: "paused" };
          case "ILLEGAL_MOVE":
          case "AMBIGUOUS_MOVE":
            return { kind: "illegal", envelope: error.envelope };
          default:
            throw error;
        }
      }
    },
  };
}
