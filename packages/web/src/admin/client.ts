import type { z } from "zod";
import { jsonRequestInit, parseJson, responseError } from "../api/http.js";
import {
  type AdminActivity,
  type AdminActivityWindow,
  type AdminBonuses,
  type AdminConfig,
  type AdminError,
  type AdminGameDossier,
  type AdminGameSummary,
  type AdminOverview,
  type AdminPlayer,
  type AdminPlayers,
  adminActivitySchema,
  adminBonusesSchema,
  adminConfigMutationSchema,
  adminConfigSchema,
  adminErrorSchema,
  adminGameDossierSchema,
  adminGameSummarySchema,
  adminOverviewSchema,
  adminPauseStateSchema,
  adminPlayerSchema,
  adminPlayerSummarySchema,
  type GamesPage,
  gamesPageSchema,
} from "../api/schemas.js";

export type AdminOverviewResult =
  | {
      readonly kind: "data";
      readonly overview: AdminOverview;
      readonly etag: string | null;
    }
  | { readonly kind: "not_modified"; readonly etag: string | null };

export type AdminClient = ReturnType<typeof createAdminClient>;

export function createAdminClient(
  options: { readonly fetchFn?: typeof fetch } = {},
) {
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);

  async function request(
    path: string,
    init: {
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const response = await fetchFn(`/api/v1${path}`, jsonRequestInit(init));
    if (!response.ok && response.status !== 304) {
      throw await responseError(response);
    }
    return response;
  }

  async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    return parseJson(response, schema);
  }

  return {
    async getAdminOverview(etag?: string): Promise<AdminOverviewResult> {
      const response = await request("/admin/overview", {
        headers: etag === undefined ? {} : { "If-None-Match": etag },
      });
      const nextEtag = response.headers.get("ETag");
      if (response.status === 304) {
        return { kind: "not_modified", etag: nextEtag ?? etag ?? null };
      }
      return {
        kind: "data",
        overview: await json(response, adminOverviewSchema),
        etag: nextEtag,
      };
    },

    async getAdminActivity(
      window: AdminActivityWindow,
    ): Promise<AdminActivity> {
      return json(
        await request(
          `/admin/activity?${new URLSearchParams({ window }).toString()}`,
        ),
        adminActivitySchema,
      );
    },

    async getAdminBonuses(page: number): Promise<AdminBonuses> {
      return json(
        await request(`/admin/bonuses?page=${page}`),
        adminBonusesSchema,
      );
    },

    async getAdminErrors(input: {
      readonly level?: string;
      readonly code?: string;
      readonly page: number;
    }): Promise<GamesPage<AdminError>> {
      const query = new URLSearchParams({ page: String(input.page) });
      if (input.level !== undefined) query.set("level", input.level);
      if (input.code !== undefined) query.set("code", input.code);
      return json(
        await request(`/admin/errors?${query.toString()}`),
        gamesPageSchema(adminErrorSchema),
      );
    },

    async getAdminGames(input: {
      readonly status?: string;
      readonly q?: string;
      readonly page: number;
    }): Promise<GamesPage<AdminGameSummary>> {
      const query = new URLSearchParams({ page: String(input.page) });
      if (input.status !== undefined) query.set("status", input.status);
      if (input.q !== undefined && input.q !== "") query.set("q", input.q);
      return json(
        await request(`/admin/games?${query.toString()}`),
        gamesPageSchema(adminGameSummarySchema),
      );
    },

    async getAdminGame(gameId: string): Promise<AdminGameDossier> {
      return json(
        await request(`/admin/games/${encodeURIComponent(gameId)}`),
        adminGameDossierSchema,
      );
    },

    async getAdminPlayer(address: string): Promise<AdminPlayer> {
      return json(
        await request(`/admin/players/${encodeURIComponent(address)}`),
        adminPlayerSchema,
      );
    },

    async getAdminPlayers(input: {
      readonly kind?: "human" | "agent";
      readonly q?: string;
      readonly page: number;
    }): Promise<AdminPlayers> {
      const query = new URLSearchParams({ page: String(input.page) });
      if (input.kind !== undefined) query.set("kind", input.kind);
      if (input.q !== undefined && input.q !== "") query.set("q", input.q);
      return json(
        await request(`/admin/players?${query.toString()}`),
        gamesPageSchema(adminPlayerSummarySchema),
      );
    },

    async getAdminConfig(): Promise<AdminConfig> {
      return json(await request("/admin/config"), adminConfigSchema);
    },

    async pauseAdmin(banner?: string): Promise<void> {
      await json(
        await request("/admin/pause", {
          method: "POST",
          body: banner === undefined || banner === "" ? {} : { banner },
        }),
        adminPauseStateSchema,
      );
    },

    async resumeAdmin(): Promise<void> {
      await json(
        await request("/admin/resume", { method: "POST" }),
        adminPauseStateSchema,
      );
    },

    async setAdminConfig(key: string, value: unknown): Promise<void> {
      await json(
        await request(`/admin/config/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: { value },
        }),
        adminConfigMutationSchema,
      );
    },

    async revertAdminConfig(key: string): Promise<void> {
      await json(
        await request(`/admin/config/${encodeURIComponent(key)}`, {
          method: "DELETE",
        }),
        adminConfigMutationSchema,
      );
    },
  };
}
