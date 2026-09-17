import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { digest, equalSecret, HttpError, limitedJson, randomToken } from "./security.js";
import type { Store } from "./store.js";
import type { Worker } from "./worker.js";
import { miniHtml, miniScript, miniStyle } from "./mini-ui.js";

export function verifyMiniIdentity(raw: string, botToken: string, now = Date.now()): string {
  const fields = new URLSearchParams(raw);
  if (!raw || raw.length > 16384 || new Set(fields.keys()).size !== [...fields.keys()].length) {
    throw new HttpError(403, "Invalid Telegram session. Close and reopen the Mini App.");
  }
  const hash = fields.get("hash");
  fields.delete("hash");
  fields.sort();
  const check = [...fields].map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  const date = Number(fields.get("auth_date"));
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !equalSecret(hash, expected) ||
      !Number.isSafeInteger(date) || date > now / 1000 + 30 || now / 1000 - date > 600) {
    throw new HttpError(403, "Telegram session expired or invalid. Close and reopen the Mini App.");
  }
  try {
    const user = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), is_bot: z.literal(false).optional() })
      .parse(JSON.parse(fields.get("user") ?? "null"));
    return String(user.id);
  } catch {
    throw new HttpError(403, "Telegram user identity is missing. Open the Mini App from the bot.");
  }
}

export async function miniRoute(req: Request, config: Config, store: Store, worker: Worker,
  background: (work: Promise<void>) => void): Promise<Response | undefined> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET") {
    if (path === "/mini") {
      return new Response(miniHtml, { headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'self' https://telegram.org/js/telegram-web-app.js; style-src 'self'; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org; base-uri 'none'; form-action 'none'",
      } });
    }
    if (path === "/mini/app.js" || path === "/mini/app.css") {
      return new Response(path.endsWith(".js") ? miniScript : miniStyle, {
        headers: { "Content-Type": path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" },
      });
    }
  }
  if (req.method !== "POST" || !["/mini/session", "/mini/status"].includes(path)) {
    return undefined;
  }
  if (req.headers.get("origin") !== config.PUBLIC_BASE_URL) {
    throw new HttpError(403, "Invalid origin");
  }
  const parsed = z.object({ initData: z.string().max(16384), session: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() })
    .safeParse(await limitedJson(req, 20000));
  if (!parsed.success) { throw new HttpError(400, "Invalid setup request"); }
  const sender = verifyMiniIdentity(parsed.data.initData, config.TELEGRAM_BOT_TOKEN);
  if (path === "/mini/session") {
    const tenant = await store.ensureTenant(sender);
    if (tenant.status !== "pending") { return Response.json({ status: tenant.status }); }
    const session = randomToken();
    const initHash = digest(new URLSearchParams(parsed.data.initData).get("hash")!);
    const [created] = await store.db.query(
      `INSERT INTO demo_mini_sessions(hash,init_hash,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')
       ON CONFLICT(init_hash) DO NOTHING RETURNING hash`, [digest(session), initHash, tenant.id]);
    if (!created) { throw new HttpError(409, "This Telegram session has already started setup. Close and reopen the Mini App to try again."); }
    const ticket = await store.ticket(tenant.id, "onboard", { miniSession: digest(session) });
    return Response.json({ status: "pending", session, url: `${config.PUBLIC_BASE_URL}/onboard?ticket=${ticket}` });
  }
  if (!parsed.data.session) { throw new HttpError(400, "Missing setup session"); }
  const hash = digest(parsed.data.session);
  const [session] = await store.db.query<{ tenant_id: string; email: string | null }>(
    `SELECT s.tenant_id,s.email FROM demo_mini_sessions s JOIN demo_tenants t ON t.id=s.tenant_id
     WHERE s.hash=$1 AND t.telegram_id=$2 AND s.expires_at>now()`, [hash, sender]);
  if (!session) { throw new HttpError(403, "Setup session expired. Close and reopen the Mini App."); }
  if (session.email) {
    const { email } = store.vault.open<{ email: string }>(session.email, hash);
    await store.approve(session.tenant_id, email);
    background(worker.drain());
  }
  const tenant = await store.tenant(session.tenant_id);
  return Response.json({ status: tenant.status });
}
