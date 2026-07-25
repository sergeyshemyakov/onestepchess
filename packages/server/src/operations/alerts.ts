import type { Logger } from "../logger.js";

const SECRET_KEY =
  /authorization|cookie|jwt|mnemonic|private|secret|signature|signed|payload_b64|payment/i;

export function sanitizeOperationalPayload(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "string") {
    let sanitized = value;
    for (const secret of secrets) {
      if (secret.length > 0)
        sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
    return sanitized;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOperationalPayload(item, secrets));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeOperationalPayload(item, secrets);
    }
    return result;
  }
  return value;
}

export type AlertTransport = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<unknown>;

export class OperationalAlerts {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly deps: {
      readonly url?: string;
      readonly dedupeSeconds: () => number;
      readonly now: () => number;
      readonly transport: AlertTransport;
      readonly logger: Logger;
      readonly secrets?: readonly string[];
    },
  ) {}

  async emit(
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<boolean> {
    const now = this.deps.now();
    const prior = this.lastSent.get(type);
    if (
      prior !== undefined &&
      now - prior < this.deps.dedupeSeconds() * 1_000
    ) {
      return false;
    }
    this.lastSent.set(type, now);
    const body = {
      type,
      at: new Date(now).toISOString(),
      payload: sanitizeOperationalPayload(payload, this.deps.secrets),
    };
    if (this.deps.url === undefined) return true;
    try {
      await this.deps.transport(this.deps.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.deps.logger.warn(
        { err: error, alertType: type },
        "operational alert delivery failed",
      );
    }
    return true;
  }
}
