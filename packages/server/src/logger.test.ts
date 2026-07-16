import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

class CaptureStream {
  chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  output(): string {
    return this.chunks.join("");
  }
}

describe("pino logger redaction", () => {
  it("never emits secret values in captured log output", () => {
    const mnemonic = "abandon ability able about treasury secret words";
    const jwtSecret = "super-secret-jwt-signing-key-0123456789";
    const adminToken = "admin-token-abcdef0123456789";
    const capture = new CaptureStream();
    const logger = createLogger({
      level: "info",
      secrets: [mnemonic, jwtSecret, adminToken],
      destination: capture,
    });

    logger.info({ JWT_SECRET: jwtSecret, nested: { token: adminToken } }, "boot");
    logger.error(`failed with ${mnemonic}`);
    logger.info("plain line survives");

    const output = capture.output();
    expect(output).toContain("plain line survives");
    expect(output).not.toContain(mnemonic);
    expect(output).not.toContain(jwtSecret);
    expect(output).not.toContain(adminToken);
  });

  it("emits structured JSON lines", () => {
    const capture = new CaptureStream();
    const logger = createLogger({ level: "info", destination: capture });
    logger.info({ port: 1234 }, "listening");
    const line = JSON.parse(capture.chunks[0] ?? "{}");
    expect(line.msg).toBe("listening");
    expect(line.port).toBe(1234);
  });
});
