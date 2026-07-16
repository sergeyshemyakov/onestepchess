import { randomUUID } from "node:crypto";
import type { Move } from "@onestepchess/core";
import { Hono } from "hono";
import type { Logger } from "../logger.js";

/** Pinned error taxonomy (server spec §6.2) plus NOT_FOUND — the shape every
 * unknown route (and cloaked admin route) answers with. */
export const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  INVALID_ADDRESS: 400,
  INVALID_SIGNATURE: 401,
  NONCE_EXPIRED: 401,
  REKEYED_UNSUPPORTED: 400,
  REGISTRATION_REQUIRED: 400,
  TURNSTILE_FAILED: 400,
  INVALID_NICKNAME: 400,
  NICKNAME_TAKEN: 409,
  UNAUTHENTICATED: 401,
  BANNED: 403,
  QUOTA_OUT: 429,
  RATE_LIMITED: 429,
  RENAME_RATE_LIMITED: 429,
  DEMO_HUMANS_ONLY: 403,
  TURNSTILE_REQUIRED: 400,
  GUEST_DEMO_USED: 403,
  BONUS_NOT_ELIGIBLE: 403,
  BONUS_UNAVAILABLE: 429,
  NO_OPEN_CLAIM: 404,
  CLAIM_NOT_FOUND: 404,
  NOT_YOUR_CLAIM: 403,
  CLAIM_EXPIRED: 410,
  ILLEGAL_MOVE: 400,
  AMBIGUOUS_MOVE: 400,
  PAYMENT_REQUIRED: 402,
  PAYMENT_INVALID: 402,
  INSUFFICIENT_FUNDS: 402,
  NOT_OPTED_IN: 402,
  PAYMENT_UNAVAILABLE: 503,
  PAYMENT_IN_FLIGHT: 409,
  OPTIN_INVALID: 400,
  DEPENDENCY_UNAVAILABLE: 503,
  GAME_NOT_FOUND: 404,
  PAUSED: 503,
  NOT_FOUND: 404,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type AppErrorOptions = {
  readonly hint: string;
  readonly suggestion?: string;
  readonly legalMoves?: readonly Move[];
  readonly retryAfterSeconds?: number;
  readonly headers?: Readonly<Record<string, string>>;
};

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly options: AppErrorOptions,
  ) {
    super(`${code}: ${options.hint}`);
    this.name = "AppError";
  }
}

export type SessionInfo = {
  readonly address: string;
  readonly kind: "human" | "agent" | "guest";
  readonly jti: string;
  readonly exp: number;
};

export type AppEnv = {
  Variables: {
    requestId: string;
    /** Set by sessionAuth middleware on authenticated routes only. */
    session: SessionInfo;
  };
};

export type AppDeps = {
  readonly logger: Logger;
  readonly publicBaseUrl: string;
  readonly mode: () => "running" | "paused";
};

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const docs = (code: ErrorCode) =>
    `${deps.publicBaseUrl}/llms.txt#err-${code.toLowerCase()}`;

  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof AppError) {
      const { hint, suggestion, legalMoves, retryAfterSeconds, headers } =
        error.options;
      for (const [name, value] of Object.entries(headers ?? {})) {
        c.header(name, value);
      }
      if (retryAfterSeconds !== undefined) {
        c.header("Retry-After", String(Math.ceil(retryAfterSeconds)));
      }
      return c.json(
        {
          error: error.code,
          hint,
          docs: docs(error.code),
          ...(suggestion !== undefined ? { suggestion } : {}),
          ...(legalMoves !== undefined ? { legalMoves } : {}),
        },
        ERROR_STATUS[error.code],
      );
    }
    const requestId = c.get("requestId");
    deps.logger.error(
      { requestId, err: error, path: c.req.path },
      "unhandled error",
    );
    return c.json(
      {
        error: "INTERNAL",
        hint: "unexpected server error",
        docs: docs("INTERNAL"),
        requestId,
      },
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      { error: "NOT_FOUND", hint: "unknown route", docs: docs("NOT_FOUND") },
      404,
    ),
  );

  app.get("/healthz", (c) => c.json({ status: "ok", mode: deps.mode() }));

  return app;
}
