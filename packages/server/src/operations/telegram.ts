import type { AlertBody, AlertTransport } from "./alerts.js";

// Telegram rejects messages above 4096 UTF-16 code units.
const TELEGRAM_MESSAGE_LIMIT = 4096;

export type TelegramAlertConfig = {
  readonly botToken: string;
  readonly chatId: string;
};

export function formatTelegramAlert(body: AlertBody): string {
  const lines = [`⚠️ onestepchess alert: ${body.type}`, body.at];
  const payload = JSON.stringify(body.payload, null, 2);
  if (payload !== undefined && payload !== "{}") lines.push(payload);
  const text = lines.join("\n");
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 1)}…`;
}

export async function deliverTelegramAlert(
  config: TelegramAlertConfig,
  transport: AlertTransport,
  body: AlertBody,
): Promise<void> {
  const result = await transport(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: formatTelegramAlert(body),
      }),
    },
  );
  // fetch resolves on HTTP errors, so a rejected sendMessage (bad chat id,
  // revoked token) would otherwise be silently dropped.
  if (result instanceof Response && !result.ok) {
    const detail = (await result.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `telegram sendMessage rejected: HTTP ${result.status} ${detail}`,
    );
  }
}
