import type { TurnstileVerifier } from "../auth/turnstile.js";
import { AppError } from "./app.js";

export async function requireTurnstile(
  verifier: TurnstileVerifier,
  token: string,
  ip: string,
): Promise<void> {
  const result = await verifier(token, ip);
  if (result === "unavailable") {
    throw new AppError("DEPENDENCY_UNAVAILABLE", {
      hint: "captcha verification unavailable; retry shortly",
      retryAfterSeconds: 5,
    });
  }
  if (result === "fail") {
    throw new AppError("TURNSTILE_FAILED", {
      hint: "captcha verification failed",
    });
  }
}
