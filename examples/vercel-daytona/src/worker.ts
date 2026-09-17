import type { Config } from "./config.js";
import { digest } from "./security.js";
import { z } from "zod";
import type { Runtime } from "./runtime.js";
import type { Job, Store, Tenant } from "./store.js";
import { confirmationCommand, privateSender, type Update } from "./telegram.js";
import { sendWhatsApp, waMessage, waPayload, waSignature, type WhatsAppMessage } from "./whatsapp.js";

export class Worker {
  constructor(
    private config: Config,
    private store: Store,
    private runtime: Runtime,
    private sendTelegram: (id: string, text: string) => Promise<void>,
    private sendWa: (id: string, text: string) => Promise<void> = (id, text) => sendWhatsApp(config, id, text),
  ) {}

  private send(id: string, text: string): Promise<void> {
    return id.startsWith("whatsapp:") ? this.sendWa(id.slice(9), text.replaceAll("Telegram", "WhatsApp")) : this.sendTelegram(id, text);
  }

  async drain(kind?: Job["kind"]): Promise<void> {
    const deadline = Date.now() + 280_000;
    for (let i = 0; i < 20 && Date.now() < deadline; i++) {
      const job = await this.store.claim(kind);
      if (!job) {
        break;
      }
      try {
        const tenant = await this.store.tenant(job.tenant_id);
        if (job.kind === "provision") {
          if (tenant.status !== "active") {
            await this.runtime.provision(tenant);
          }
          await this.send(
            tenant.telegram_id,
            "Your assistant is ready. Send a message, or use /connect to connect Google.",
          );
        } else if (job.kind === "oauth_notice") {
          const event = z.object({
            provider: z.enum(["google", "outlook", "pearson"]),
            resuming: z.boolean(),
          }).parse(this.store.vault.open(job.payload, job.id));
          const receiptStarted = Date.now();
          await this.send(
            tenant.telegram_id,
            `${event.provider === "google" ? "Google" : event.provider === "pearson" ? "Pearson" : "Microsoft"} sign-in returned successfully. ${event.resuming ? "I’m checking access and continuing your request here." : "Access still needs verification. You can continue here in chat."}`,
          );
          const deliveredAt = Date.now();
          const queuedAt = job.created_at ? new Date(job.created_at).getTime() : NaN;
          console.info("OAuth receipt delivered", {
            provider: event.provider,
            channel: tenant.telegram_id.startsWith("whatsapp:") ? "whatsapp" : "telegram",
            attempt: job.attempts,
            sendMs: deliveredAt - receiptStarted,
            queueToReceiptMs: Number.isFinite(queuedAt) ? Math.max(0, deliveredAt - queuedAt) : null,
          });
        } else if (job.kind === "oauth_resume") {
          const event = z.object({
            conversationId: z.string().min(1).max(200),
            provider: z.enum(["google", "outlook", "pearson"]),
            requestedAt: z.iso.datetime().optional(),
          }).parse(this.store.vault.open(job.payload, job.id));
          if (tenant.status !== "active") { throw new Error("Assistant is not active"); }
          const resumed = await this.runtime.request(tenant, "/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: event.conversationId,
              clientMessageId: job.id,
              sourceChannel: "vellum",
              interface: "web",
              hidden: true,
              scripted: true,
              content: `Integration event: ${event.provider} browser consent returned successfully. This is a machine event, not a new user request or permission. Token exchange and API access still need verification. Check actual access with a read, then resume only the user's existing authorized request in this conversation. ${event.requestedAt ? `The sign-in link was requested at ${event.requestedAt}; identify the request pending at that time, not a newer unrelated topic.` : "Identify the request that led to this consent, not a newer unrelated topic."} Respect any later cancellation or revision of that request. If the user only asked for connection status, verify access without inventing another task. Do not say the connection is ready until the read succeeds. Do not send email or change calendar events merely because consent completed. Send the verified result or a plain-language failure through the messaging tool to the originating Telegram or WhatsApp chat identified by this conversation's prior messages. Do not switch to another linked channel. A normal text reply to this internal event is not delivered to that chat. Never expose credentials.`,
            }),
          });
          if (!resumed.ok) { throw new Error("OAuth continuation was not accepted"); }
        } else if (job.kind === "whatsapp") {
          const message = waMessage.parse(this.store.vault.open(job.payload, job.id));
          const source = await this.store.ensureTenant(`whatsapp:${message.from}`);
          if (source.id !== tenant.id) { throw new Error("Channel ownership mismatch"); }
          await this.deliver(source, { update_id: 0, message: { from: { id: 1 }, chat: { id: 1, type: "private" }, text: message.text?.body } }, message);
        } else {
          if (this.config.TELEGRAM_UPDATE_BOT_ID && !job.id.startsWith(`telegram:${this.config.TELEGRAM_UPDATE_BOT_ID}:`)) {
            throw new Error("Telegram job belongs to the previous bot");
          }
          const update = this.store.vault.open<Update>(job.payload, job.id);
          const sender = privateSender(update);
          if (!sender) { throw new Error("Invalid Telegram sender"); }
          const source = await this.store.ensureTenant(sender);
          if (source.id !== tenant.id) { throw new Error("Channel ownership mismatch"); }
          await this.deliver(source, update);
        }
        await this.store.finish(job);
      } catch {
        await this.store.finish(job, true);
      }
      // Reserve the full time budget for a provisioning attempt on the next invocation.
      if (Date.now() > deadline - 265_000) {
        break;
      }
    }
  }
  private async deliver(tenant: Tenant, update: Update, whatsapp?: WhatsAppMessage): Promise<void> {
    const text = update.message?.text?.trim() ?? "";
    const raw = confirmationCommand(text);
    if (raw !== undefined) {
      if (tenant.status !== "pending") {
        await this.send(tenant.telegram_id, tenant.status === "active"
          ? "Your assistant is already ready. Send a message to get started."
          : "Your assistant is being set up. I’ll message you when it is ready.");
        return;
      }
      const ticket = /^[A-Za-z0-9_-]{43}$/.test(raw) ? await this.store.peek(raw, "confirm") : undefined;
      if (!ticket || ticket.tenant_id !== tenant.id || !ticket.payload) {
        await this.send(
          tenant.telegram_id,
          "This setup link has expired or belongs to another Telegram account. Send /start to try again.",
        );
        return;
      }
      const { email } = this.store.vault.open<{ email: string }>(
        ticket.payload,
        digest(raw),
      );
      await this.store.approve(tenant.id, email);
      await this.store.consume(raw, "confirm");
      const approved = await this.store.tenant(tenant.id);
      await this.send(
        tenant.telegram_id,
        approved.status === "active" ? "Your existing assistant is linked. Send a message to get started." : "Access confirmed. I’m setting up your assistant and will message you when it is ready.",
      );
      return;
    }
    if (tenant.status === "pending") {
      const [allowed] = await this.store.db.query(
        `UPDATE demo_tenants SET last_gate_at=now() WHERE id=$1
        AND (last_gate_at IS NULL OR last_gate_at<now()-interval '1 minute') RETURNING id`,
        [tenant.id],
      );
      if (allowed) {
        const ticket = await this.store.ticket(tenant.id, "onboard");
        try {
          await this.send(
            tenant.telegram_id,
            `Sign in to access the demo: ${this.config.PUBLIC_BASE_URL}/onboard?ticket=${ticket}`,
          );
        } catch (error) {
          await this.store.db.query(
            "UPDATE demo_tenants SET last_gate_at=NULL WHERE id=$1",
            [tenant.id],
          );
          throw error;
        }
      }
      return;
    }
    if (tenant.status !== "active") {
      throw new Error("Assistant provisioning in progress");
    }
    if (text === "/connect" || text === "/connect outlook") {
      const outlook = text === "/connect outlook";
      if (outlook && (!this.config.MICROSOFT_CLIENT_ID || !this.config.MICROSOFT_CLIENT_SECRET)) {
        await this.send(tenant.telegram_id, "Outlook connection is not configured yet. Your existing connections are unchanged.");
        return;
      }
      const ticket = await this.store.ticket(tenant.id, "connect", { provider: outlook ? "outlook" : "google" });
      await this.send(
        tenant.telegram_id,
        `Connect ${outlook ? "Outlook Mail and Calendar" : "Gmail and Google Calendar"}: ${this.config.PUBLIC_BASE_URL}/connect?ticket=${ticket}${outlook ? "" : "\nUse /connect outlook to connect Microsoft instead."}`,
      );
      return;
    }
    if (whatsapp) {
      if (whatsapp.type !== "text") {
        await this.send(tenant.telegram_id, "This demo supports text messages. Please send your request as text.");
        return;
      }
      for (const [field, value] of Object.entries({ access_token: this.config.WHATSAPP_ACCESS_TOKEN, phone_number_id: this.config.WHATSAPP_PHONE_NUMBER_ID, app_secret: this.config.WHATSAPP_APP_SECRET })) {
        if (!value) { throw new Error("WhatsApp configuration missing"); }
        const saved = await this.runtime.request(tenant, "/v1/credentials/set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "whatsapp", field, value }) });
        if (!saved.ok) { throw new Error("WhatsApp credential setup failed"); }
      }
      const linked = await this.runtime.request(tenant, "/v1/contacts/guardian/channel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "whatsapp", address: whatsapp.from, externalUserId: whatsapp.from, status: "active" }) });
      if (!linked.ok) { throw new Error("WhatsApp channel setup failed"); }
      const body = JSON.stringify(waPayload(this.config, whatsapp));
      const delivered = await this.runtime.request(tenant, "/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": waSignature(body, this.config.WHATSAPP_APP_SECRET!) }, body });
      if (!delivered.ok) { throw new Error("WhatsApp delivery failed"); }
      return;
    }
    if (tenant.channel_alias) {
      const channel = await this.runtime.request(tenant, "/v1/contacts/guardian/channel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "telegram", address: tenant.telegram_id, externalUserId: tenant.telegram_id, status: "active" }) });
      if (!channel.ok) { throw new Error("Telegram channel setup failed"); }
    }
    const response = await this.runtime.request(tenant, "/webhooks/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!response.ok) {
      throw new Error("Assistant delivery failed");
    }
  }
}
