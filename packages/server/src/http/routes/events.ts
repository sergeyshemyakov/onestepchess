import type { Hono } from "hono";
import { z } from "zod";
import type { EventStreamService } from "../../events/service.js";
import { type AppEnv, AppError } from "../app.js";
import { type AuthRouteDeps, sessionAuth } from "./auth.js";

export type EventRouteDeps = AuthRouteDeps & {
  readonly events: EventStreamService;
};

const cursorSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());

export function registerEventRoutes(
  app: Hono<AppEnv>,
  deps: EventRouteDeps,
): void {
  app.get("/api/v1/events", sessionAuth(deps), (c) => {
    const rawCursor =
      c.req.header("last-event-id") ?? c.req.query("lastEventId");
    const parsed =
      rawCursor === undefined
        ? { success: true, data: null }
        : cursorSchema.safeParse(rawCursor);
    if (!parsed.success) {
      throw new AppError("INVALID_REQUEST", {
        hint: "Last-Event-ID must be a non-negative integer",
      });
    }

    const encoder = new TextEncoder();
    let close: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        close = deps.events.open({
          session: c.get("session"),
          cursor: parsed.data,
          sink: {
            write(chunk) {
              controller.enqueue(encoder.encode(chunk));
            },
            close() {
              controller.close();
            },
          },
        });
      },
      cancel() {
        close?.();
      },
    });

    return c.newResponse(body, 200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  });
}
