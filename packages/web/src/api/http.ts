import type { z } from "zod";
import { type ErrorEnvelope, errorEnvelopeSchema } from "./schemas.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly envelope: ErrorEnvelope,
    readonly retryAfterSeconds: number | null,
    readonly headers: Headers,
  ) {
    super(`${envelope.error}: ${envelope.hint}`);
    this.name = "ApiError";
  }

  get code(): string {
    return this.envelope.error;
  }
}

export function retryAfterSecondsFrom(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function decodeEnvelope(
  response: Response,
): Promise<ErrorEnvelope> {
  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch {
    // A non-JSON error still needs a displayable envelope.
  }
  return {
    error: "INTERNAL",
    hint: `unexpected response (${response.status})`,
    docs: "",
  };
}

export function jsonRequestInit(init: {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}): RequestInit {
  return {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: {
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  };
}

export async function responseError(response: Response): Promise<ApiError> {
  return new ApiError(
    response.status,
    await decodeEnvelope(response),
    retryAfterSecondsFrom(response.headers),
    response.headers,
  );
}

export async function parseJson<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      {
        error: "INTERNAL",
        hint: "response failed wire validation",
        docs: "",
      },
      null,
      response.headers,
    );
  }
  return parsed.data;
}
