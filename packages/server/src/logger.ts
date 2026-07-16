import { type Logger, pino } from "pino";

export type LoggerOptions = {
  readonly level?: string;
  /** Secret values scrubbed from every serialized log line — redaction by
   * value, not by key path, so a secret embedded in any message or field can
   * never reach the destination. */
  readonly secrets?: readonly string[];
  readonly destination?: { write(chunk: string): unknown };
};

export type { Logger };

export function createLogger(options: LoggerOptions = {}): Logger {
  const secrets = (options.secrets ?? []).filter(
    (secret) => secret.length > 0,
  );
  const destination = options.destination ?? process.stdout;
  const scrubbing = {
    write(chunk: string): void {
      let line = chunk;
      for (const secret of secrets) {
        line = line.split(secret).join("[REDACTED]");
      }
      destination.write(line);
    },
  };
  return pino({ level: options.level ?? "info" }, scrubbing);
}
