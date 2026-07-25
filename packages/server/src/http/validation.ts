import type { z } from "zod";
import { AppError } from "./app.js";

type JsonRequest = {
  json(): Promise<unknown>;
};

export async function parseJsonBody<T>(
  schema: z.ZodType<T>,
  request: JsonRequest,
  invalidHint: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("INVALID_REQUEST", { hint: "body must be JSON" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("INVALID_REQUEST", { hint: invalidHint });
  }
  return parsed.data;
}

export function parseQuery<T>(
  schema: z.ZodType<T>,
  value: unknown,
  invalidHint = "invalid query parameters",
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("INVALID_REQUEST", { hint: invalidHint });
  }
  return parsed.data;
}
