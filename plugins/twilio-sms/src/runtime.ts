import type { Database } from "bun:sqlite";
import { resolveCredential, runConversationTurn, type InitContext } from "@vellumai/plugin-api";
import { claim, openStore } from "./store.ts";
import { finalText, parseConfig, type SmsConfig } from "./normalize.ts";

let db: Database | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let active: Promise<void> | undefined;
let controller: AbortController | undefined;

async function processNext(store: Database, config: SmsConfig): Promise<void> {
  // Resolve before claiming so a missing credential leaves the message pending.
  const token = await resolveCredential("twilio-sms/auth_token");
  const job = claim(store);
  if (!job) { return; }
  try {
    const turn = await runConversationTurn({
      channel: {
        sourceChannel: "plugin",
        externalChatId: `twilio-sms:${job.sender}`,
        externalUserId: `twilio-sms:${job.sender}`,
      },
      content: [{ type: "text", text: job.body }],
      signal: controller?.signal,
    });
    store.query("UPDATE messages SET conversation_id = ? WHERE sid = ?").run(turn.conversationId, job.sid);
    if (turn.queued) { throw new Error("Conversation busy; reply requires review"); }
    const reply = finalText(turn.content);
    if (!reply) { throw new Error("Assistant returned no text reply"); }
    if (reply.length > 1600) { throw new Error("Reply exceeds Twilio's 1600 character limit; review required"); }
    store.query("UPDATE messages SET reply = ?, state = 'sending' WHERE sid = ?").run(reply, job.sid);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${config.accountSid}:${token}`).toString("base64")}` },
      body: new URLSearchParams({ From: config.phoneNumber, To: job.sender, Body: reply }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json() as { sid?: string; code?: number; status?: string };
    if (!response.ok || !result.sid) {
      throw new Error(`Twilio rejected reply: HTTP ${response.status}, code ${result.code ?? "unknown"}`);
    }
    store.query("UPDATE messages SET state = 'submitted', outbound_sid = ? WHERE sid = ?").run(result.sid, job.sid);
  } catch (error) {
    // An uncertain send is never automatically repeated and billed twice.
    store.query("UPDATE messages SET state = 'review_required', error = ? WHERE sid = ?")
      .run(error instanceof Error ? error.message : "SMS processing failed", job.sid);
  }
}

export function start(context: InitContext): void {
  const config = parseConfig(context.config);
  db = openStore(context.pluginStorageDir, true);
  db.query("UPDATE messages SET state = 'review_required', error = 'Interrupted; inspect before retrying' WHERE state IN ('processing', 'sending')").run();
  if (!config.enabled) { return; }
  controller = new AbortController();
  timer = setInterval(() => {
    if (active || !db) { return; }
    if (!db.query("SELECT sid FROM messages WHERE state = 'pending' LIMIT 1").get()) { return; }
    active = processNext(db, config).catch(() => {
      context.logger.warn({}, "SMS worker could not access its credential or storage");
    }).finally(() => { active = undefined; });
  }, 1000);
}

export async function stop(): Promise<void> {
  if (timer) { clearInterval(timer); }
  controller?.abort();
  await active;
  db?.close();
  db = undefined;
}

export function purge(conversationId: string): void {
  db?.query("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
}
