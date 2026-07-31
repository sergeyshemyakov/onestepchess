import type { Context, Hono } from "hono";
import { z } from "zod";
import { type AppEnv, AppError } from "../http/app.js";
import { parseJsonBody } from "../http/validation.js";
import type { ReconciliationDeps } from "../operations/reconciliation.js";
import { runReconciliation } from "../operations/reconciliation.js";
import { type AdminAuthDeps, adminAuth } from "./auth.js";
import type { AdminReadCache } from "./cache.js";
import type { AdminCommandDeps } from "./commands.js";
import {
  type AdminReadDeps,
  adminActivity,
  adminBonuses,
  adminConfig,
  adminErrors,
  adminGame,
  adminGames,
  adminOverview,
  adminPlayer,
  adminPlayers,
} from "./read-models.js";

const pageQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
});
const activityQuery = z.object({
  window: z.enum(["24h", "7d", "30d", "all"]).default("24h"),
});
const errorsQuery = pageQuery.extend({
  level: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
});
const gamesQuery = pageQuery.extend({
  status: z.enum(["active", "endspiel", "finished", "aborted"]).optional(),
  q: z.string().max(100).optional(),
});
const playersQuery = pageQuery.extend({
  kind: z.enum(["human", "agent"]).optional(),
  q: z.string().max(100).optional(),
});
const pauseBody = z
  .object({ banner: z.string().min(1).max(240).optional() })
  .strict();
const banBody = z.object({ banned: z.boolean() }).strict();
const quotaBody = z
  .object({ override: z.number().int().nonnegative().nullable() })
  .strict();
const configBody = z.object({ value: z.unknown() }).strict();
const adjustmentBody = z
  .object({
    deltaMicroUsdc: z.number().int(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type AdminRouteDeps = AdminAuthDeps &
  AdminReadDeps & {
    readonly coordinator: AdminCommandDeps["coordinator"];
    readonly cache: AdminReadCache;
    readonly reconciliation: ReconciliationDeps;
  };

function query<T extends z.ZodType>(
  schema: T,
  raw: Record<string, string>,
): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AppError("INVALID_REQUEST", {
      hint: result.error.issues.map((issue) => issue.message).join("; "),
    });
  }
  return result.data;
}

async function cached(
  c: Context<AppEnv>,
  deps: AdminRouteDeps,
  key: string,
  compute: () => unknown | Promise<unknown>,
): Promise<Response> {
  const entry = await deps.cache.get(key, compute);
  if (c.req.header("if-none-match") === entry.etag) {
    return c.body(null, 304, { ETag: entry.etag });
  }
  c.header("ETag", entry.etag);
  return c.json(entry.value);
}

async function dispatch<R>(
  deps: AdminRouteDeps,
  type: string,
  payload: Record<string, unknown>,
): Promise<R> {
  const result = await deps.coordinator.dispatch<Record<string, unknown>, R>({
    type,
    payload,
  });
  if (result.kind !== "ok") throw new Error("admin command deprioritized");
  return result.result;
}

export function registerAdminRoutes(
  app: Hono<AppEnv>,
  deps: AdminRouteDeps,
): void {
  app.use("/api/v1/admin/*", adminAuth(deps));

  app.get("/api/v1/admin/overview", (c) =>
    cached(c, deps, "overview", () => adminOverview(deps)),
  );
  app.get("/api/v1/admin/activity", (c) => {
    const input = query(activityQuery, c.req.query());
    return cached(c, deps, `activity:${input.window}`, () =>
      adminActivity(deps, input.window),
    );
  });
  app.get("/api/v1/admin/errors", (c) => {
    const input = query(errorsQuery, c.req.query());
    return cached(
      c,
      deps,
      `errors:${input.level ?? ""}:${input.code ?? ""}:${input.page}`,
      () => adminErrors(deps, input),
    );
  });
  app.get("/api/v1/admin/games", (c) => {
    const input = query(gamesQuery, c.req.query());
    return cached(
      c,
      deps,
      `games:${input.status ?? ""}:${input.q ?? ""}:${input.page}`,
      () => adminGames(deps, input),
    );
  });
  app.get("/api/v1/admin/games/:id", (c) =>
    cached(c, deps, `games:${c.req.param("id")}`, () => {
      const result = adminGame(deps, c.req.param("id"));
      if (result === null) {
        throw new AppError("GAME_NOT_FOUND", { hint: "game not found" });
      }
      return result;
    }),
  );
  app.get("/api/v1/admin/players", (c) => {
    const input = query(playersQuery, c.req.query());
    return cached(
      c,
      deps,
      `players:${input.kind ?? ""}:${input.q ?? ""}:${input.page}`,
      () => adminPlayers(deps, input),
    );
  });
  app.get("/api/v1/admin/players/:address", (c) =>
    cached(c, deps, `players:${c.req.param("address")}`, () => {
      const result = adminPlayer(deps, c.req.param("address"));
      if (result === null) {
        throw new AppError("NOT_FOUND", { hint: "player not found" });
      }
      return result;
    }),
  );
  app.get("/api/v1/admin/config", (c) =>
    cached(c, deps, "config", () => adminConfig(deps)),
  );
  app.get("/api/v1/admin/bonuses", (c) => {
    const input = query(pageQuery, c.req.query());
    return cached(c, deps, `bonuses:${input.page}`, () =>
      adminBonuses(deps, input.page),
    );
  });

  app.post("/api/v1/admin/pause", async (c) => {
    const body = await parseJsonBody(pauseBody, c.req, "invalid pause request");
    return c.json(
      await dispatch(deps, "AdminPause", {
        actor: c.get("adminActor"),
        banner: body.banner,
      }),
    );
  });
  app.post("/api/v1/admin/resume", async (c) =>
    c.json(
      await dispatch(deps, "AdminResume", {
        actor: c.get("adminActor"),
      }),
    ),
  );
  app.put("/api/v1/admin/config/:key", async (c) => {
    const body = await parseJsonBody(configBody, c.req, "invalid config value");
    const result = await dispatch<
      | { ok: true; effect: string; revision: number }
      | { ok: false; reason: string; details?: string }
    >(deps, "AdminSetConfig", {
      actor: c.get("adminActor"),
      key: c.req.param("key"),
      value: body.value,
    });
    if (!result.ok) {
      throw new AppError("INVALID_REQUEST", {
        hint: result.details ?? `config key is ${result.reason}`,
      });
    }
    return c.json(result);
  });
  app.delete("/api/v1/admin/config/:key", async (c) => {
    const result = await dispatch<
      | { ok: true; effect: string; revision: number }
      | { ok: false; reason: string; details?: string }
    >(deps, "AdminRevertConfig", {
      actor: c.get("adminActor"),
      key: c.req.param("key"),
    });
    if (!result.ok) {
      throw new AppError("INVALID_REQUEST", {
        hint: result.details ?? `config key is ${result.reason}`,
      });
    }
    return c.json(result);
  });
  app.post("/api/v1/admin/games/:id/abort", async (c) => {
    const result = await dispatch<{
      status: string;
      gameId?: string;
      refundJobs?: number;
    }>(deps, "AdminAbort", {
      actor: c.get("adminActor"),
      gameId: c.req.param("id"),
    });
    if (result.status === "not_found") {
      throw new AppError("GAME_NOT_FOUND", { hint: "game not found" });
    }
    if (result.status === "payment_in_flight") {
      throw new AppError("PAYMENT_IN_FLIGHT", {
        hint: "the open claim has a payment in flight",
      });
    }
    if (result.status === "terminal") {
      throw new AppError("INVALID_REQUEST", {
        hint: "finished games cannot be aborted",
      });
    }
    return c.json({
      gameId: result.gameId,
      refundJobs: result.refundJobs,
    });
  });
  app.post("/api/v1/admin/players/:address/ban", async (c) => {
    const body = await parseJsonBody(banBody, c.req, "invalid ban request");
    const result = await dispatch<{ found: boolean; banned: boolean }>(
      deps,
      "AdminBan",
      {
        actor: c.get("adminActor"),
        address: c.req.param("address"),
        banned: body.banned,
      },
    );
    if (!result.found) {
      throw new AppError("NOT_FOUND", { hint: "player not found" });
    }
    return c.json(result);
  });
  app.post("/api/v1/admin/players/:address/quota", async (c) => {
    const body = await parseJsonBody(quotaBody, c.req, "invalid quota request");
    const result = await dispatch<{ found: boolean; override: number | null }>(
      deps,
      "AdminSetQuota",
      {
        actor: c.get("adminActor"),
        address: c.req.param("address"),
        override: body.override,
      },
    );
    if (!result.found) {
      throw new AppError("NOT_FOUND", { hint: "player not found" });
    }
    return c.json(result);
  });
  app.post("/api/v1/admin/reconcile", async (c) => {
    const result = await runReconciliation(
      deps.reconciliation,
      "admin",
      c.get("adminActor"),
    );
    deps.cache.invalidate("overview", "activity");
    return c.json(result);
  });
  app.post("/api/v1/admin/treasury/adjust", async (c) => {
    const body = await parseJsonBody(
      adjustmentBody,
      c.req,
      "invalid treasury adjustment",
    );
    const result = await dispatch<{
      status: string;
      expectedDeltaMicroUsdc?: number | null;
      reconciliation?: unknown;
    }>(deps, "AdminTreasuryAdjustment", {
      actor: c.get("adminActor"),
      ...body,
    });
    if (result.status === "not_paused") {
      throw new AppError("INVALID_REQUEST", {
        hint: "treasury adjustment requires paused mode",
      });
    }
    if (result.status === "drift_mismatch") {
      throw new AppError("INVALID_REQUEST", {
        hint: `adjustment must exactly match investigated drift; expected ${result.expectedDeltaMicroUsdc}`,
      });
    }
    return c.json(result);
  });
  app.post("/api/v1/admin/payouts/:id/retry", async (c) => {
    const result = await dispatch<{ status: string; payoutId?: string }>(
      deps,
      "AdminPayoutRetry",
      {
        actor: c.get("adminActor"),
        payoutId: c.req.param("id"),
      },
    );
    if (result.status === "not_found") {
      throw new AppError("NOT_FOUND", { hint: "payout not found" });
    }
    if (result.status === "not_failed") {
      throw new AppError("INVALID_REQUEST", {
        hint: "only exhausted failed payouts can be retried",
      });
    }
    return c.json(result);
  });
  app.post("/api/v1/admin/bonuses/:address/retry", () => {
    throw new AppError("BONUS_UNAVAILABLE", {
      hint: "starter-stake funding is unavailable until Release 4",
    });
  });
}
