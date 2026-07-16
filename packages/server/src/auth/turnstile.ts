export type TurnstileResult = "pass" | "fail" | "unavailable";

export type TurnstileVerifier = (
  token: string,
  ip: string | null,
) => Promise<TurnstileResult>;

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Server-side siteverify with injectable fetch: dev/CI inject fixtures —
 * there is no production auth bypass and no test-login route (release plan
 * §3.2). A transport outage is recoverable (`DEPENDENCY_UNAVAILABLE`). */
export function createTurnstileVerifier(options: {
  readonly secret: string;
  readonly fetchFn?: typeof fetch;
}): TurnstileVerifier {
  const fetchFn = options.fetchFn ?? fetch;
  return async (token, ip) => {
    const body = new URLSearchParams({
      secret: options.secret,
      response: token,
    });
    if (ip !== null) {
      body.set("remoteip", ip);
    }
    try {
      const response = await fetchFn(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!response.ok) {
        return "unavailable";
      }
      const json = (await response.json()) as { success?: boolean };
      return json.success === true ? "pass" : "fail";
    } catch {
      return "unavailable";
    }
  };
}
