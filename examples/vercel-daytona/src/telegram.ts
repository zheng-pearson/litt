import { z } from "zod";
import { createHmac } from "node:crypto";
import type { Config } from "./config.js";

export function telegramWebhookSecret(config: Config): string {
  if (!config.TELEGRAM_UPDATE_BOT_ID) {
    return config.TELEGRAM_WEBHOOK_SECRET;
  }
  return createHmac("sha256", config.TELEGRAM_WEBHOOK_SECRET)
    .update(`telegram:${config.TELEGRAM_UPDATE_BOT_ID}`)
    .digest("hex");
}

const identity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const message = z
  .object({
    from: z.object({ id: identity, is_bot: z.boolean().optional() }),
    chat: z.object({ id: identity, type: z.literal("private") }),
    text: z.string().optional(),
  })
  .passthrough();
export const updateSchema = z
  .object({
    update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    message: message.optional(),
    edited_message: message.optional(),
    callback_query: z
      .object({
        from: z.object({ id: identity }),
        message: message.omit({ from: true }).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Update = z.infer<typeof updateSchema>;

export function confirmationPayload(token: string): string {
  return `confirm_${token}`;
}

export function confirmationCommand(text: string): string | undefined {
  if (text.startsWith("/start confirm_")) {
    return text.slice(15);
  }
  if (text === "/confirm" || text.startsWith("/confirm ")) {
    return text.slice(9);
  }
  return undefined;
}

export async function botUsername(token: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error("Unable to resolve Telegram bot");
  }
  return z.object({
    ok: z.literal(true),
    result: z.object({ username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/) }),
  }).parse(await response.json()).result.username;
}

export function privateSender(update: Update): string | undefined {
  const msg = update.message ?? update.edited_message;
  const from = msg?.from.id ?? update.callback_query?.from.id;
  const chat = msg?.chat.id ?? update.callback_query?.message?.chat.id;
  if (!from || from !== chat || msg?.from.is_bot) {
    return undefined;
  }
  return String(from);
}

export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok || !((await response.json()) as { ok?: boolean }).ok) {
    throw new Error("Telegram delivery failed");
  }
}

export async function acknowledgeTelegram(token: string, chatId: string, fetcher: typeof fetch): Promise<void> {
  const response = await fetcher(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok || !((await response.json()) as { ok?: boolean }).ok) {
    throw new Error("Telegram acknowledgement failed");
  }
}
