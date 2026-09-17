import type { Config } from "./config.js";
import type { Runtime } from "./runtime.js";
import type { Store, Tenant } from "./store.js";
import { telegramWebhookSecret } from "./telegram.js";

export async function registerTelegramWebhook(config: Config, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${config.PUBLIC_BASE_URL}/webhooks/telegram`,
      secret_token: telegramWebhookSecret(config),
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !((await response.json()) as { ok?: boolean }).ok) {
    throw new Error("Telegram registration failed");
  }
}

export async function reconcileTelegramBot(config: Config, store: Store, runtime: Runtime, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!config.TELEGRAM_UPDATE_BOT_ID) {
    return true;
  }
  let stage = "queue-check";
  return store.db.transaction(async (tx) => {
    const [lock] = await tx.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(7812394) AS locked");
    if (!lock?.locked) {
      return false;
    }
    const [busy] = await tx.query("SELECT id FROM demo_jobs WHERE status='running' AND lease_until>now() LIMIT 1");
    if (busy) {
      return false;
    }
    const [legacy] = await tx.query(
      "SELECT id FROM demo_jobs WHERE kind='telegram' AND status<>'done' AND id NOT LIKE $1 LIMIT 1",
      [`telegram:${config.TELEGRAM_UPDATE_BOT_ID}:%`],
    );
    if (legacy) {
      stage = "legacy-jobs-pending";
      throw new Error("Drain previous bot jobs before Telegram cutover");
    }
    stage = "bot-identity";
    const identity = await fetcher(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!identity.ok) {
      throw new Error("Replacement bot identity check failed");
    }
    const bot = await identity.json() as { ok?: boolean; result?: { id?: number } };
    if (!bot.ok || String(bot.result?.id) !== config.TELEGRAM_UPDATE_BOT_ID) {
      throw new Error("Replacement bot identity mismatch");
    }
    const tenants = await tx.query<Tenant>("SELECT * FROM demo_tenants WHERE status='active' AND merged_into IS NULL ORDER BY created_at");
    stage = "assistant-credentials";
    for (const tenant of tenants) {
      if (!runtime.configureTelegram) {
        throw new Error("Runtime does not support Telegram cutover");
      }
      await runtime.configureTelegram(tenant);
    }
    stage = "webhook-registration";
    await registerTelegramWebhook(config, fetcher);
    console.info("Telegram reconciliation complete", { assistants: tenants.length });
    return true;
  }).catch(() => {
    console.warn("Telegram reconciliation failed", { stage });
    throw new Error(`Telegram reconciliation failed: ${stage}`);
  });
}
