import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { OperationalAlerts } from "./alerts.js";
import { formatTelegramAlert } from "./telegram.js";

const silentLogger = { warn: () => {} } as unknown as Logger;

describe("formatTelegramAlert", () => {
  it("renders_type_timestamp_and_payload", () => {
    const text = formatTelegramAlert({
      type: "reconciliation_drift",
      at: "2026-08-13T10:00:00.000Z",
      payload: { driftMicroUsdc: 1234 },
    });
    expect(text).toContain("reconciliation_drift");
    expect(text).toContain("2026-08-13T10:00:00.000Z");
    expect(text).toContain('"driftMicroUsdc": 1234');
  });

  it("omits_the_payload_block_when_empty", () => {
    const text = formatTelegramAlert({
      type: "boot_paused",
      at: "2026-08-13T10:00:00.000Z",
      payload: {},
    });
    expect(text).not.toContain("{}");
  });

  it("truncates_to_the_telegram_message_limit", () => {
    const text = formatTelegramAlert({
      type: "stall_abort",
      at: "2026-08-13T10:00:00.000Z",
      payload: { blob: "x".repeat(10_000) },
    });
    expect(text.length).toBeLessThanOrEqual(4096);
  });
});

describe("OperationalAlerts telegram sink", () => {
  it("posts_sendMessage_with_chat_id_and_text", async () => {
    const transport = vi.fn(async () => ({}));
    const alerts = new OperationalAlerts({
      telegram: { botToken: "123:abc", chatId: "42" },
      dedupeSeconds: () => 60,
      now: () => 1_755_000_000_000,
      transport,
      logger: silentLogger,
    });
    await alerts.emit("stall_abort", { gameId: "g1" });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe("42");
    expect(body.text).toContain("stall_abort");
    expect(body.text).toContain("g1");
  });

  it("delivers_to_webhook_and_telegram_from_one_emit", async () => {
    const transport = vi.fn(async () => ({}));
    const alerts = new OperationalAlerts({
      url: "https://hooks.example/ops",
      telegram: { botToken: "123:abc", chatId: "42" },
      dedupeSeconds: () => 60,
      now: () => 1_755_000_000_000,
      transport,
      logger: silentLogger,
    });
    await alerts.emit("manual_pause");
    const urls = transport.mock.calls.map((call) => call[0]);
    expect(urls).toContain("https://hooks.example/ops");
    expect(urls).toContain("https://api.telegram.org/bot123:abc/sendMessage");
  });

  it("telegram_failure_is_logged_and_does_not_block_the_webhook", async () => {
    const warn = vi.fn();
    const transport = vi.fn(async (url: string) => {
      if (url.includes("telegram")) throw new Error("telegram down");
      return {};
    });
    const alerts = new OperationalAlerts({
      url: "https://hooks.example/ops",
      telegram: { botToken: "123:abc", chatId: "42" },
      dedupeSeconds: () => 60,
      now: () => 1_755_000_000_000,
      transport,
      logger: { warn } as unknown as Logger,
    });
    await expect(alerts.emit("manual_pause")).resolves.toBe(true);
    expect(transport).toHaveBeenCalledWith(
      "https://hooks.example/ops",
      expect.anything(),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sink: "telegram" }),
      "operational alert delivery failed",
    );
  });

  it("logs_a_delivery_failure_when_telegram_rejects_with_an_http_error", async () => {
    const warn = vi.fn();
    const transport = vi.fn(
      async () =>
        new Response(
          '{"ok":false,"description":"Bad Request: chat not found"}',
          {
            status: 400,
          },
        ),
    );
    const alerts = new OperationalAlerts({
      telegram: { botToken: "123:abc", chatId: "<chat-id>" },
      dedupeSeconds: () => 60,
      now: () => 1_755_000_000_000,
      transport,
      logger: { warn } as unknown as Logger,
    });
    await expect(alerts.emit("manual_pause")).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sink: "telegram" }),
      "operational alert delivery failed",
    );
    const [context] = warn.mock.calls[0] as [{ err: Error }];
    expect(String(context.err)).toContain("400");
    expect(String(context.err)).toContain("chat not found");
  });

  it("redacts_secrets_in_the_telegram_text", async () => {
    const transport = vi.fn(async () => ({}));
    const alerts = new OperationalAlerts({
      telegram: { botToken: "123:abc", chatId: "42" },
      dedupeSeconds: () => 60,
      now: () => 1_755_000_000_000,
      transport,
      logger: silentLogger,
      secrets: ["super-secret-token"],
    });
    await alerts.emit("manual_pause", { detail: "leaked super-secret-token" });
    const [, init] = transport.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(init.body).not.toContain("super-secret-token");
    expect(init.body).toContain("[REDACTED]");
  });
});
