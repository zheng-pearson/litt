import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { equalSecret, HttpError, limitedBody } from "./security.js";
import type { Store } from "./store.js";

export const waMessage = z.object({ id: z.string().min(1).max(256), from: z.string().regex(/^\d{7,15}$/), type: z.string(), text: z.object({ body: z.string().max(16384) }).optional(), timestamp: z.string().optional() });
export type WhatsAppMessage = z.infer<typeof waMessage>;
export function waSignature(body: string | Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
export function waPayload(config: Config, message: WhatsAppMessage) {
  return { object: "whatsapp_business_account", entry: [{ id: config.WHATSAPP_BUSINESS_ACCOUNT_ID, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.WHATSAPP_PHONE_NUMBER_ID }, messages: [message] } }] }] };
}
export async function sendWhatsApp(config: Config, to: string, text: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) { throw new Error("WhatsApp credentials missing"); }
  const response = await fetcher(`https://graph.facebook.com/v23.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text, preview_url: false } }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) { throw new Error("WhatsApp reply failed"); }
}
export async function whatsappIngress(req: Request, config: Config, store: Store): Promise<Response> {
  if (!config.WHATSAPP_APP_SECRET || !config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_VERIFY_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !config.WHATSAPP_BUSINESS_ACCOUNT_ID || !config.WHATSAPP_PHONE_NUMBER) { throw new HttpError(503, "WhatsApp is not configured"); }
  if (req.method === "GET") {
    const params = new URL(req.url).searchParams;
    if (params.get("hub.mode") !== "subscribe" || !equalSecret(params.get("hub.verify_token"), config.WHATSAPP_VERIFY_TOKEN)) { throw new HttpError(403, "Invalid verification token"); }
    return new Response(params.get("hub.challenge") ?? "", { headers: { "Content-Type": "text/plain" } });
  }
  if (req.method !== "POST") { throw new HttpError(405, "Method not allowed"); }
  const body = await limitedBody(req);
  if (!equalSecret(req.headers.get("x-hub-signature-256"), waSignature(body, config.WHATSAPP_APP_SECRET))) { throw new HttpError(403, "Invalid signature"); }
  let value: unknown;
  try { value = JSON.parse(body.toString()); } catch { throw new HttpError(400, "Invalid JSON"); }
  const parsed = z.object({ object: z.literal("whatsapp_business_account"), entry: z.array(z.object({ id: z.string(), changes: z.array(z.object({ field: z.string(), value: z.object({ metadata: z.object({ phone_number_id: z.string() }).optional(), messages: z.array(z.unknown()).optional() }) })) })) }).safeParse(value);
  if (!parsed.success) { throw new HttpError(400, "Invalid WhatsApp payload"); }
  for (const entry of parsed.data.entry) {
    if (entry.id !== config.WHATSAPP_BUSINESS_ACCOUNT_ID) { continue; }
    for (const change of entry.changes) {
      if (change.field !== "messages" || change.value.metadata?.phone_number_id !== config.WHATSAPP_PHONE_NUMBER_ID) { continue; }
      for (const candidate of change.value.messages ?? []) {
        const message = waMessage.safeParse(candidate);
        if (!message.success) { continue; }
        const tenant = await store.ensureTenant(`whatsapp:${message.data.from}`);
        await store.enqueue(`whatsapp:${message.data.id}`, tenant.id, "whatsapp", message.data);
      }
    }
  }
  return Response.json({ ok: true });
}
