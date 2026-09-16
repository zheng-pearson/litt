/**
 * THROWAWAY SPIKE — multi-tenant Telegram router for Vellum.
 *
 * Proves one shared Telegram bot token can front N single-tenant Vellum
 * instances. Not production code: the tenant map is a literal, there is no
 * persistence, no OAuth, and no error budget.
 *
 * Flow:
 *   Telegram --> (one webhook URL) --> this router --> instance gateway
 *   instance --> Telegram sendMessage (shared bot token, no routing needed)
 *
 * The gate: unknown senders get a deterministic reply and NEVER reach a
 * Vellum instance, so they cannot burn inference budget.
 */

const PORT = Number(process.env.ROUTER_PORT ?? 8999);
const BOT_TOKEN = process.env.BOT_TOKEN ?? "";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

/** Per-tenant routing target. In production this is a DB lookup. */
type Tenant = {
  instanceUrl: string;
  /** The instance's own credential/telegram/webhook_secret. */
  webhookSecret: string;
  label: string;
};

/**
 * telegram user id -> tenant. Populated from env so the spike can be
 * re-pointed without editing code.
 *
 * ROUTES='<userId>=<label>|<url>|<secret>;<userId>=...'
 */
const ROUTES = new Map<string, Tenant>();
for (const entry of (process.env.ROUTES ?? "").split(";").filter(Boolean)) {
  const [userId, rest] = entry.split("=");
  const [label, instanceUrl, webhookSecret] = rest.split("|");
  ROUTES.set(userId.trim(), { label, instanceUrl, webhookSecret });
}

console.log(`[router] listening on :${PORT}`);
for (const [userId, t] of ROUTES) {
  console.log(`[router]   ${userId} -> ${t.label} (${t.instanceUrl})`);
}

/** Deterministic gate reply. No LLM, no Vellum instance touched. */
async function sendGateReply(chatId: number | string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "You're not set up yet. Sign in to get access: https://example.com/oauth/start",
    }),
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    if (url.pathname !== "/webhooks/telegram" || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const raw = await req.text();
    let update: any;
    try {
      update = JSON.parse(raw);
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const msg = update.message ?? update.edited_message ?? update.callback_query?.message;
    const fromId = String(
      update.message?.from?.id ??
        update.edited_message?.from?.id ??
        update.callback_query?.from?.id ??
        "",
    );
    const chatId = msg?.chat?.id;

    const tenant = ROUTES.get(fromId);

    if (!tenant) {
      // The gate. Unknown sender never reaches an instance.
      console.log(`[router] GATE  from=${fromId} (unknown) -> deterministic reply`);
      if (chatId != null) await sendGateReply(chatId);
      return new Response("ok");
    }

    console.log(`[router] ROUTE from=${fromId} -> ${tenant.label}`);

    // Forward verbatim, with THIS instance's webhook secret.
    const res = await fetch(`${tenant.instanceUrl}/webhooks/telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": tenant.webhookSecret,
      },
      body: raw,
    });

    console.log(`[router]   ${tenant.label} responded ${res.status}`);
    return new Response("ok");
  },
});
