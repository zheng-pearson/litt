import { z } from "zod";
import { allowedEmail, type Config } from "./config.js";
import {
  digest,
  equalSecret,
  HttpError,
  limitedJson,
  randomToken,
} from "./security.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";
import { acknowledgeTelegram, botUsername, confirmationPayload, privateSender, telegramWebhookSecret, updateSchema } from "./telegram.js";
import type { Worker } from "./worker.js";
import { miniRoute } from "./mini.js";
import { whatsappIngress } from "./whatsapp.js";
import { connectionRoute } from "./connections.js";
import { startPearsonConnection, verifyPearsonCallback } from "./pearson.js";
import { reconcileTelegramBot } from "./telegram-cutover.js";

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (v) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        v
      ]!,
  );
function page(title: string, text: string, action?: string, telegram?: { username: string; token: string }, actionLabel = "Continue with Google"): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><main><h1>${escape(title)}</h1><p>${escape(text)}</p>${action ? `<form method="post" action="${escape(action)}"><button type="submit">${escape(actionLabel)}</button></form>` : ""}${telegram ? `<form method="get" action="https://t.me/${escape(telegram.username)}"><input type="hidden" name="start" value="${escape(confirmationPayload(telegram.token))}"><button type="submit">Finish setup in Telegram</button></form><p>Use the same Telegram account that started setup. Tap Start if Telegram asks. This link expires in 10 minutes; send /start to the bot for a new link.</p>` : ""}</main></html>`,
    {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

export function createApp(
  config: Config,
  store: Store,
  runtime: Runtime,
  worker: Worker,
  background: (work: Promise<void>) => void,
  fetcher: typeof fetch = fetch,
) {
  const redirect = (location: string, cookie?: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: location,
        ...(cookie ? { "Set-Cookie": cookie } : {}),
      },
    });
  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const connection = await connectionRoute(req, config, store);
    if (connection) { return connection; }
    if (url.pathname === "/webhooks/whatsapp") {
      const response = await whatsappIngress(req, config, store);
      if (req.method === "POST") { background(worker.drain()); }
      return response;
    }
    const mini = await miniRoute(req, config, store, worker, background);
    if (mini) { return mini; }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "vellum-hosted-demo" });
    }
    if (req.method === "GET" && url.pathname === "/") {
      return page(
        "Second",
        "Start a private conversation with the demo Telegram bot. Use /start to sign in or /connect to connect Google.",
      );
    }
    if (url.pathname === "/webhooks/telegram" && req.method === "POST") {
      const receivedAt = Date.now();
      if (
        !equalSecret(
          req.headers.get("x-telegram-bot-api-secret-token"),
          telegramWebhookSecret(config),
        )
      ) {
        throw new HttpError(401, "Unauthorized");
      }
      const raw = await limitedJson(req);
      const parsed = updateSchema.safeParse(raw);
      if (!parsed.success) {
        return Response.json({ ok: true, ignored: true });
      }
      const sender = privateSender(parsed.data);
      if (!sender) {
        return Response.json({ ok: true, ignored: true });
      }
      const tenant = await store.ensureTenant(sender);
      const inserted = await store.enqueue(
        config.TELEGRAM_UPDATE_BOT_ID
          ? `telegram:${config.TELEGRAM_UPDATE_BOT_ID}:${parsed.data.update_id}`
          : `telegram:${parsed.data.update_id}`,
        tenant.id,
        "telegram",
        raw,
      );
      if (inserted && tenant.status === "active" && parsed.data.message?.text) {
        background(acknowledgeTelegram(config.TELEGRAM_BOT_TOKEN, sender, fetcher).then(() => {
          console.info("Telegram acknowledgement", { elapsedMs: Date.now() - receivedAt });
        }).catch(() => {
          console.warn("Telegram acknowledgement unavailable; durable delivery continues");
        }));
      }
      background(worker.drain());
      return Response.json({ ok: true });
    }
    if (
      url.pathname === "/jobs/drain" &&
      (req.method === "GET" || req.method === "POST")
    ) {
      if (
        !equalSecret(
          req.headers.get("authorization"),
          `Bearer ${config.CRON_SECRET}`,
        )
      ) {
        throw new HttpError(401, "Unauthorized");
      }
      if (!(await reconcileTelegramBot(config, store, runtime, fetcher))) {
        return Response.json({ ok: true, deferred: true });
      }
      await worker.drain();
      await store.db.query(
        "DELETE FROM demo_tickets WHERE expires_at<now()-interval '1 day'",
      );
      await store.db.query("DELETE FROM demo_mini_sessions WHERE expires_at<now()-interval '1 day'");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/admin/status" && req.method === "GET") {
      if (
        !equalSecret(
          req.headers.get("authorization"),
          `Bearer ${config.CRON_SECRET}`,
        )
      ) {
        throw new HttpError(401, "Unauthorized");
      }
      return Response.json({
        tenants: await store.db.query(
          "SELECT id,status,sandbox_id FROM demo_tenants ORDER BY created_at",
        ),
        jobs: await store.db.query(
          "SELECT status,count(*)::integer AS count FROM demo_jobs GROUP BY status",
        ),
        failures: await store.db.query(
          "SELECT id,tenant_id,attempts,last_error FROM demo_jobs WHERE status='failed' ORDER BY created_at LIMIT 20",
        ),
      });
    }
    if (
      (url.pathname === "/onboard" || url.pathname === "/connect") &&
      ["GET", "POST"].includes(req.method)
    ) {
      const kind = url.pathname === "/onboard" ? "onboard" : "connect";
      const raw = url.searchParams.get("ticket") ?? "";
      const ticket = await store.peek(raw, kind);
      if (!ticket) {
        throw new HttpError(
          400,
          "Link expired. Request a new link in Telegram.",
        );
      }
      const connectorContext = ticket.payload ? store.vault.open<{ provider?: string; service?: "gmail" | "calendar" | "both"; conversationId?: string; requestedAt?: string } | null>(ticket.payload, digest(raw)) : null;
      const pearson = kind === "connect" && connectorContext?.provider === "pearson";
      const outlook = kind === "connect" && connectorContext?.provider === "outlook";
      if (req.method === "GET") {
        return page(
          kind === "onboard" ? "Sign in to the demo" : pearson ? "Connect Pearson" : outlook ? "Connect Outlook" : "Connect Google",
          kind === "onboard"
            ? config.PUBLIC_SIGNUP === "true" ? "Sign in with Google to create your assistant." : "Only invited accounts can create an assistant."
            : pearson ? "Sign in to Pearson and choose which deals Second can read. Second cannot edit deals, send messages or approve documents through this connection." : outlook ? "Microsoft will ask for permission to read and manage mail and calendar events, and send email on your behalf." : connectorContext?.service === "gmail" ? "Google will ask for permission to read Gmail. Sending email is not requested." : connectorContext?.service === "calendar" ? "Google will ask for permission to manage calendar events." : "Google will ask you to grant read access to Gmail and access to calendar events.",
          `${url.pathname}?ticket=${encodeURIComponent(raw)}`,
          undefined,
          pearson ? "Continue with Pearson" : outlook ? "Continue with Microsoft" : "Continue with Google",
        );
      }
      if (req.headers.get("origin") !== config.PUBLIC_BASE_URL) {
        throw new HttpError(403, "Invalid origin");
      }
      if (!(await store.consume(raw, kind))) {
        throw new HttpError(400, "Link already used");
      }
      const tenant = await store.tenant(ticket.tenant_id);
      const cookieNonce = randomToken();
      if (kind === "onboard") {
        const context = ticket.payload ? store.vault.open<{ miniSession?: string } | null>(ticket.payload, digest(raw)) : null;
        const state = await store.ticket(tenant.id, "login", {
          cookie: digest(cookieNonce),
          ...(context?.miniSession ? { miniSession: context.miniSession } : {}),
        });
        const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        auth.search = new URLSearchParams({
          client_id: config.GOOGLE_CLIENT_ID,
          redirect_uri: `${config.PUBLIC_BASE_URL}/auth/google/callback`,
          response_type: "code",
          scope: "openid email",
          state,
          prompt: "select_account",
        }).toString();
        return redirect(
          auth.href,
          `demo_login=${cookieNonce}; Path=/auth/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        );
      }
      if (pearson) {
        if (tenant.status !== "active") { throw new HttpError(409, "Assistant is not ready yet"); }
        const flow = await startPearsonConnection(config, tenant, runtime);
        if (flow.alreadyAuthenticated) { return page("Pearson is already connected", "Return to Second and ask for a live deal read. To change the allowed deals, revoke the connection in Pearson first, then connect again."); }
        await store.ticket(tenant.id, "callback", { cookie: digest(cookieNonce), provider: "pearson", conversationId: connectorContext?.conversationId, requestedAt: connectorContext?.requestedAt }, flow.state);
        return redirect(flow.authUrl, `demo_connect=${cookieNonce}; Path=/webhooks/oauth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      }
      if (tenant.status !== "active" || (!outlook && !tenant.google_app_id)) {
        throw new HttpError(409, "Assistant is not ready yet");
      }
      let appId = tenant.google_app_id;
      if (outlook) {
        if (!config.MICROSOFT_CLIENT_ID || !config.MICROSOFT_CLIENT_SECRET) {
          throw new HttpError(503, "Outlook connection is not configured yet");
        }
        const registered = await runtime.request(tenant, "/v1/oauth/apps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider_key: "outlook", client_id: config.MICROSOFT_CLIENT_ID, client_secret: config.MICROSOFT_CLIENT_SECRET }),
        });
        if (!registered.ok) {
          throw new Error("Microsoft connector registration failed");
        }
        appId = z.object({ app: z.object({ id: z.string().min(1) }) }).parse(await registered.json()).app.id;
      }
      const response = await runtime.request(
        tenant,
        `/v1/oauth/apps/${encodeURIComponent(appId!)}/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_transport: "gateway",
            scopes: outlook ? ["openid", "profile", "email", "offline_access", "User.Read", "Calendars.ReadWrite", "Mail.ReadWrite", "Mail.Send"] : [
              "openid",
              "email",
              ...(connectorContext?.service === "calendar" ? [] : ["https://www.googleapis.com/auth/gmail.readonly"]),
              ...(connectorContext?.service === "gmail" ? [] : ["https://www.googleapis.com/auth/calendar.events"]),
            ],
          }),
        },
      );
      if (!response.ok) {
        throw new Error("Connection could not start");
      }
      const flow = z
        .object({ auth_url: z.url(), state: z.string().min(16) })
        .parse(await response.json());
      if (new URL(flow.auth_url).origin !== (outlook ? "https://login.microsoftonline.com" : "https://accounts.google.com")) {
        throw new Error("Unexpected OAuth provider");
      }
      await store.ticket(
        tenant.id,
        "callback",
        { cookie: digest(cookieNonce), provider: outlook ? "outlook" : "google", conversationId: connectorContext?.conversationId, requestedAt: connectorContext?.requestedAt },
        flow.state,
      );
      return redirect(
        flow.auth_url,
        `demo_connect=${cookieNonce}; Path=/webhooks/oauth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      );
    }
    if (
      req.method === "GET" &&
      ["/auth/google/callback", "/webhooks/oauth/callback"].includes(
        url.pathname,
      )
    ) {
      const login = url.pathname === "/auth/google/callback";
      const raw = url.searchParams.get("state") ?? "";
      const kind = login ? "login" : "callback";
      const ticket = await store.peek(raw, kind);
      if (!ticket?.payload) {
        throw new HttpError(
          400,
          "OAuth session expired. Request a new link in Telegram.",
        );
      }
      const data = store.vault.open<{ cookie: string; miniSession?: string; provider?: string; conversationId?: string; requestedAt?: string }>(
        ticket.payload,
        digest(raw),
      );
      const name = login ? "demo_login" : "demo_connect";
      const cookie = req.headers
        .get("cookie")
        ?.split(";")
        .map((p) => p.trim())
        .find((p) => p.startsWith(`${name}=`))
        ?.slice(name.length + 1);
      if (!cookie || !equalSecret(digest(cookie), data.cookie)) {
        throw new HttpError(403, "Use the same browser that started sign-in");
      }
      if (login) {
        if (!(await store.consume(raw, kind))) {
          throw new HttpError(400, "OAuth session already used");
        }
        if (url.searchParams.has("error")) {
          return page("Sign-in cancelled", "Return to Telegram to try again.");
        }
        const code = url.searchParams.get("code");
        if (!code) {
          throw new HttpError(400, "Missing authorization code");
        }
        const tokenResponse = await fetcher(
          "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            body: new URLSearchParams({
              code,
              client_id: config.GOOGLE_CLIENT_ID,
              client_secret: config.GOOGLE_CLIENT_SECRET,
              redirect_uri: `${config.PUBLIC_BASE_URL}/auth/google/callback`,
              grant_type: "authorization_code",
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!tokenResponse.ok) {
          throw new HttpError(
            400,
            "Sign-in failed. Request a new link in Telegram.",
          );
        }
        const tokens = z
          .object({ access_token: z.string() })
          .parse(await tokenResponse.json());
        const identity = await fetcher(
          "https://openidconnect.googleapis.com/v1/userinfo",
          {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!identity.ok) {
          throw new HttpError(403, "Unable to verify account");
        }
        const parsedUser = z
          .object({
            email: z.email(),
            email_verified: z.literal(true),
            sub: z.string(),
          })
          .safeParse(await identity.json());
        if (!parsedUser.success) {
          throw new HttpError(403, "Google account email is not verified");
        }
        const user = parsedUser.data;
        if (!allowedEmail(config, user.email)) {
          throw new HttpError(403, "This account is not invited to the demo");
        }
        if (data.miniSession) {
          const [updated] = await store.db.query(
            `UPDATE demo_mini_sessions SET email=$3 WHERE hash=$1 AND tenant_id=$2
             AND expires_at>now() AND email IS NULL RETURNING hash`,
            [data.miniSession, ticket.tenant_id, store.vault.seal({ email: user.email.toLowerCase() }, data.miniSession)],
          );
          if (!updated) { throw new HttpError(400, "Mini App session expired. Reopen the Mini App to try again."); }
          return page("Google sign-in complete", "Return to the Litt Mini App in Telegram. Setup finishes automatically there; no confirmation code is needed.");
        }
        const loginTenant = await store.tenant(ticket.tenant_id);
        if (loginTenant.telegram_id.startsWith("whatsapp:")) {
          const confirmation = await store.ticket(ticket.tenant_id, "confirm", { email: user.email.toLowerCase() });
          const target = `https://wa.me/${config.WHATSAPP_PHONE_NUMBER}?text=${encodeURIComponent(`/confirm ${confirmation}`)}`;
          return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width"><title>Finish setup</title><h1>Confirm in WhatsApp</h1><p>Return to the same WhatsApp account and send the prefilled confirmation to link your assistant.</p><a href="${escape(target)}">Finish setup in WhatsApp</a></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const username = await botUsername(config.TELEGRAM_BOT_TOKEN, fetcher);
        const confirmation = await store.ticket(ticket.tenant_id, "confirm", {
          email: user.email.toLowerCase(),
        });
        return page(
          "Google sign-in complete",
          "One last step: open Telegram to securely link your account. No code to copy or type.",
          undefined,
          { username, token: confirmation },
        );
      }
      const tenant = await store.tenant(ticket.tenant_id);
      const query = new URLSearchParams({ state: raw });
      for (const key of ["code", "error"]) {
        const value = url.searchParams.get(key);
        if (value) {
          query.set(key, value);
        }
      }
      const response = await runtime.request(
        tenant,
        `/webhooks/oauth/callback?${query}`,
      );
      if (response.status >= 500) {
        throw new Error(
          "Assistant temporarily unavailable; retry this callback",
        );
      }
      const approved = response.ok && !url.searchParams.has("error") && (data.provider !== "pearson" || await verifyPearsonCallback(tenant, runtime));
      const resume = approved && config.OAUTH_AUTOMATIC_RESUME === "true" && data.conversationId && data.provider;
      const callbackJobs: Array<{ id: string; kind: "oauth_notice" | "oauth_resume"; payload: unknown }> = [];
      if (approved && data.provider) {
        callbackJobs.push({ id: `oauth-notice:${digest(raw)}`, kind: "oauth_notice", payload: {
          provider: data.provider,
          resuming: Boolean(resume),
        } });
      }
      if (resume) {
        callbackJobs.push({ id: `oauth-resume:${digest(raw)}`, kind: "oauth_resume", payload: {
          conversationId: data.conversationId,
          provider: data.provider,
          requestedAt: data.requestedAt,
        } });
      }
      if (!(await store.consumeWithJobs(raw, kind, callbackJobs))) {
        throw new HttpError(400, "This connection callback was already completed or expired");
      }
      if (approved && data.provider) {
        background(worker.drain("oauth_notice").then(() => worker.drain()));
      }
      return page(
        approved
          ? "Sign-in approved"
          : "Connection unsuccessful",
        approved
          ? resume
            ? "Your assistant will verify access and continue your request in chat. You can close this page."
            : "Return to Telegram to continue. Your assistant still needs to verify access to the requested service before it is ready."
          : "Return to Telegram and ask for a fresh connection link to try again.",
      );
    }
    throw new HttpError(404, "Not found");
  }
  return async (req: Request): Promise<Response> => {
    let response: Response;
    try {
      response = await route(req);
    } catch (error) {
      response = Response.json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Service temporarily unavailable",
        },
        { status: error instanceof HttpError ? error.status : 503 },
      );
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "strict-origin");
    response.headers.set("X-Content-Type-Options", "nosniff");
    if (!response.headers.has("Content-Security-Policy")) { response.headers.set(
      "Content-Security-Policy",
      "default-src 'none'; form-action 'self' https://accounts.google.com https://login.microsoftonline.com https://t.me; frame-ancestors 'none'; base-uri 'none'",
    ); }
    return response;
  };
}
