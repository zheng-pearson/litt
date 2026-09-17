import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { schemaSql } from "../src/schema.js";
import { digest, Vault } from "../src/security.js";
import { Store, type Database, type Tenant } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { DaytonaRuntime, type Runtime } from "../src/runtime.js";
import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { botUsername, telegramWebhookSecret } from "../src/telegram.js";
import { createHmac } from "node:crypto";
import { verifyMiniIdentity } from "../src/mini.js";
import { waPayload, waSignature } from "../src/whatsapp.js";
import { connectionToken, installConnectionSkill } from "../src/connections.js";
import { partnerHarness } from "./partner-workflows-fixture.js";
import { reconcileTelegramBot } from "../src/telegram-cutover.js";

const pg = new PGlite();
const adapt = (client: Pick<PGlite, "query" | "transaction">): Database => ({
  async query<T>(sql: string, args: unknown[] = []) {
    return (await client.query<T>(sql, args)).rows;
  },
  async transaction<T>(fn: (db: Database) => Promise<T>) {
    return client.transaction((tx) => fn(adapt(tx as unknown as PGlite)));
  },
});
const config = readConfig({
  PUBLIC_BASE_URL: "https://demo.example.com",
  DATABASE_URL: "postgresql://unused",
  ENCRYPTION_KEY: "ab".repeat(32),
  CRON_SECRET: "c".repeat(32),
  TELEGRAM_BOT_TOKEN: "t".repeat(32),
  TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
  DAYTONA_API_KEY: "test-only",
  DAYTONA_SNAPSHOT: "test-snapshot",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  ALLOWED_EMAILS: "user@example.com",
  OAUTH_AUTOMATIC_RESUME: "true",
  OPENAI_API_KEY: "test-only",
});
const store = new Store(adapt(pg), new Vault(config.ENCRYPTION_KEY));
let sent: { id: string; text: string }[];
let calls: { tenant: Tenant; path: string; options?: RequestInit }[];
let provisioned: string[];
let background: Promise<void>[];
let upstream: (path: string) => Response;
let googleEmail: string;
let googleVerified: boolean;
const runtime: Runtime = {
  async provision(t) {
    provisioned.push(t.id);
    await store.db.query(
      "UPDATE demo_tenants SET status='active',google_app_id='google-app' WHERE id=$1",
      [t.id],
    );
  },
  async request(tenant, path, options) {
    calls.push({ tenant, path, options });
    return upstream(path);
  },
};
const worker = new Worker(
  config,
  store,
  runtime,
  async (id, text) => {
    sent.push({ id, text });
  },
  async (id, text) => {
    sent.push({ id: `whatsapp:${id}`, text });
  },
);
const app = createApp(
  config,
  store,
  runtime,
  worker,
  (work) => {
    background.push(work);
  },
  (async (input: string | URL | Request) => {
    if (String(input).endsWith("/sendChatAction")) {
      return Response.json({ ok: true });
    }
    if (String(input).endsWith("/getMe")) {
      return Response.json({ ok: true, result: { username: "example_bot" } });
    }
    if (String(input).includes("/token")) {
      return Response.json({ access_token: "test-token" });
    }
    return Response.json({
      email: googleEmail,
      email_verified: googleVerified,
      sub: "user-123",
    });
  }) as typeof fetch,
);

async function settle() {
  await Promise.all(background);
  background = [];
}
function webhook(id: number, text = "hello", sender = 123) {
  return new Request(`${config.PUBLIC_BASE_URL}/webhooks/telegram`, {
    method: "POST",
    headers: {
      "x-telegram-bot-api-secret-token": config.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      update_id: id,
      message: {
        from: { id: sender },
        chat: { id: sender, type: "private" },
        text,
      },
    }),
  });
}
async function active(sender = "123") {
  const tenant = await store.ensureTenant(sender);
  await store.db.query(
    "UPDATE demo_tenants SET status='active',google_app_id='google-app' WHERE id=$1",
    [tenant.id],
  );
  return store.tenant(tenant.id);
}
async function signIn(tenant: Tenant) {
  const ticket = await store.ticket(tenant.id, "onboard");
  const response = await app(
    new Request(`${config.PUBLIC_BASE_URL}/onboard?ticket=${ticket}`, {
      method: "POST",
      headers: { Origin: config.PUBLIC_BASE_URL },
    }),
  );
  expect(response.status).toBe(303);
  const state = new URL(response.headers.get("location")!).searchParams.get(
    "state",
  )!;
  return { state, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

beforeAll(async () => {
  await pg.exec(schemaSql);
});

describe("conversational Outlook connection capability", () => {
  function request(token: string, body: unknown = { provider: "outlook" }) {
    return new Request(`${config.PUBLIC_BASE_URL}/integrations/connect`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
  test("rejects absent, tampered and cross-tenant credentials without issuing tickets", async () => {
    const a = await active("123"),
      b = await active("456");
    const token = connectionToken(config, a.id);
    for (const value of ["", `${token}x`, `${b.id}.${token.split(".")[1]}`]) {
      expect((await app(request(value))).status).toBe(401);
    }
    expect(await store.db.query("SELECT * FROM demo_tickets")).toHaveLength(0);
  });
  test("issues a short-lived provider-bound link only for its active tenant", async () => {
    const tenant = await active();
    config.MICROSOFT_CLIENT_ID = "test-client";
    config.MICROSOFT_CLIENT_SECRET = "test-secret";
    const token = connectionToken(config, tenant.id);
    expect(
      (await app(request(token, { provider: "outlook", tenantId: "other" })))
        .status,
    ).toBe(400);
    const response = await app(request(token));
    expect(response.status).toBe(200);
    const result = await response.json();
    const raw = new URL(result.url).searchParams.get("ticket")!;
    const ticket = await store.peek(raw, "connect");
    expect(ticket?.tenant_id).toBe(tenant.id);
    expect(
      store.vault.open<{ provider: string }>(ticket!.payload!, digest(raw)),
    ).toEqual({ provider: "outlook" });
    expect(result.expires_in).toBe(600);
    expect(JSON.stringify(result)).not.toContain(token);
    await store.db.query(
      "UPDATE demo_tenants SET status='pending' WHERE id=$1",
      [tenant.id],
    );
    expect((await app(request(token))).status).toBe(403);
  });
  test("unconfigured provider cannot issue a link", async () => {
    const tenant = await active();
    expect(
      (await app(request(connectionToken(config, tenant.id)))).status,
    ).toBe(503);
    expect(await store.db.query("SELECT * FROM demo_tickets")).toHaveLength(0);
  });
  test("pins the connection request time server-side for later task resumption", async () => {
    const tenant = await active();
    const before = Date.now();
    const response = await app(request(connectionToken(config, tenant.id), { provider: "google", conversationId: "conv-123" }));
    const result = await response.json();
    const raw = new URL(result.url).searchParams.get("ticket")!;
    const ticket = await store.peek(raw, "connect");
    const context = store.vault.open<{ requestedAt: string; conversationId: string }>(ticket!.payload!, digest(raw));
    expect(context.conversationId).toBe("conv-123");
    expect(Date.parse(context.requestedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(context.requestedAt)).toBeLessThanOrEqual(Date.now());
    expect((await app(request(connectionToken(config, tenant.id), { provider: "google", requestedAt: "2000-01-01T00:00:00.000Z" }))).status).toBe(400);
    upstream = () => Response.json({ auth_url: "https://accounts.google.com/o/oauth2/v2/auth", state: "timestamp-resume-test-state" });
    const consent = await app(new Request(result.url, { method: "POST", headers: { origin: config.PUBLIC_BASE_URL } }));
    expect(consent.status).toBe(303);
    const callbackTicket = await store.peek("timestamp-resume-test-state", "callback");
    const callbackContext = store.vault.open<{ requestedAt: string }>(callbackTicket!.payload!, digest("timestamp-resume-test-state"));
    expect(callbackContext.requestedAt).toBe(context.requestedAt);
  });
  test("issues a provider-bound Google link without Microsoft configuration", async () => {
    const tenant = await active();
    await store.db.query("UPDATE demo_tenants SET google_app_id=$2 WHERE id=$1", [tenant.id, "google-test-app"]);
    const response = await app(request(connectionToken(config, tenant.id), { provider: "google" }));
    expect(response.status).toBe(200);
    const result = await response.json();
    const raw = new URL(result.url).searchParams.get("ticket")!;
    const ticket = await store.peek(raw, "connect");
    expect(ticket?.tenant_id).toBe(tenant.id);
    expect(store.vault.open<{ provider: string }>(ticket!.payload!, digest(raw))).toEqual({ provider: "google" });
  });
  test("stores capability in credentials and creates the skill without embedding secrets", async () => {
    const tenant = await active();
    upstream = (path) =>
      path.includes("/skills/")
        ? new Response(null, { status: 404 })
        : Response.json({ ok: true });
    await installConnectionSkill(config, tenant, runtime);
    const credential = calls.find(
      (call) => call.path === "/v1/credentials/set",
    )!;
    expect(JSON.parse(String(credential.options?.body)).value).toBe(
      connectionToken(config, tenant.id),
    );
    const skill = calls.find((call) => call.path === "/v1/skills")!;
    expect(String(skill.options?.body)).not.toContain(
      connectionToken(config, tenant.id),
    );
    expect(JSON.parse(String(skill.options?.body)).bodyMarkdown).toContain(
      `${config.PUBLIC_BASE_URL}/integrations/connect`,
    );
    const file = JSON.parse(
      String(
        calls.find((call) => call.path === "/v1/workspace/write")!.options
          ?.body,
      ),
    );
    expect(file.content).toContain("always-candidate: true");
    expect(file.content).toContain(
      "zero keyword-search matches do not mean an empty inbox",
    );
    expect(file.content).toContain("never relabel UTC as local time");
    expect(file.content).not.toContain(connectionToken(config, tenant.id));
    const legalFile = JSON.parse(String(calls.filter((call) => call.path === "/v1/workspace/write")[1]!.options?.body));
    expect(legalFile.content).toContain("updated brief still need all six sections");
    expect(legalFile.content).toContain("inline before saving files");
    const routingFile = JSON.parse(String(calls.filter((call) => call.path === "/v1/workspace/write")[2]!.options?.body));
    expect(routingFile.path).toBe("skills/hosted-connections-policy-v2/SKILL.md");
    expect(routingFile.content).toContain("always-candidate: true");
    expect(routingFile.content).toContain("read the current");
    expect(routingFile.content).toContain("status-only");
    calls = [];
    upstream = () => Response.json({ ok: true });
    await installConnectionSkill(config, tenant, runtime);
    expect(calls.some((call) => call.path === "/v1/skills")).toBe(false);
    calls = [];
    upstream = (path) =>
      Response.json(
        path.includes("/files/content")
          ? { content: path.includes("hosted-connections-policy") ? routingFile.content : path.includes("hosted-legal-review") ? legalFile.content : file.content }
          : { ok: true },
      );
    await installConnectionSkill(config, tenant, runtime);
    expect(calls.some((call) => call.path === "/v1/workspace/write")).toBe(
      false,
    );
    expect(calls.some((call) => call.path.includes("/v1/memory/"))).toBe(false);
  });
});
beforeEach(async () => {
  await pg.exec("TRUNCATE demo_jobs, demo_tickets, demo_tenants CASCADE");
  sent = [];
  calls = [];
  provisioned = [];
  background = [];
  googleEmail = "user@example.com";
  googleVerified = true;
  delete config.MICROSOFT_CLIENT_ID;
  delete config.MICROSOFT_CLIENT_SECRET;
  config.HOSTED_INTERACTIVE_AUTO_APPROVE = "false";
  delete config.WHATSAPP_APP_SECRET;
  upstream = () => Response.json({ ok: true });
});

describe("WhatsApp hosted ingress", () => {
  function configure() {
    Object.assign(config, {
      WHATSAPP_APP_SECRET: "test-app-secret",
      WHATSAPP_ACCESS_TOKEN: "test-only",
      WHATSAPP_VERIFY_TOKEN: "v".repeat(32),
      WHATSAPP_PHONE_NUMBER_ID: "12345",
      WHATSAPP_BUSINESS_ACCOUNT_ID: "67890",
      WHATSAPP_PHONE_NUMBER: "12025550100",
    });
  }
  function incoming(
    id = "wa-1",
    text = "hello",
    from = "12025550101",
    phone = config.WHATSAPP_PHONE_NUMBER_ID,
  ) {
    const body = JSON.stringify(
      waPayload(
        { ...config, WHATSAPP_PHONE_NUMBER_ID: phone },
        { id, from, type: "text", text: { body: text } },
      ),
    );
    return new Request(`${config.PUBLIC_BASE_URL}/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": waSignature(body, config.WHATSAPP_APP_SECRET!),
        "Content-Type": "application/json",
      },
      body,
    });
  }
  test("verification fails closed and echoes only a valid challenge", async () => {
    const url = `${config.PUBLIC_BASE_URL}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${"v".repeat(32)}&hub.challenge=12345`;
    expect((await app(new Request(url))).status).toBe(503);
    configure();
    expect(await (await app(new Request(url))).text()).toBe("12345");
    expect(
      (await app(new Request(url.replace("subscribe", "invalid")))).status,
    ).toBe(403);
  });
  test("invalid signatures and other business numbers cannot create tenants", async () => {
    configure();
    const request = incoming();
    request.headers.set("x-hub-signature-256", "sha256=bad");
    expect((await app(request)).status).toBe(403);
    expect(
      (await app(incoming("wa-1", "hello", "12025550101", "99999"))).status,
    ).toBe(200);
    await settle();
    expect(await store.db.query("SELECT * FROM demo_tenants")).toHaveLength(0);
  });
  test("new sender gets durable sign-in once, without assistant access", async () => {
    configure();
    await app(incoming());
    await settle();
    await app(incoming());
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe("whatsapp:12025550101");
    expect(sent[0]?.text).toContain("/onboard?ticket=");
    expect(calls).toHaveLength(0);
  });
  test("rejects oversized and tampered bodies before any database write", async () => {
    configure();
    const request = incoming();
    expect(
      (
        await app(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: (await request.text()) + " ",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app(
          new Request(request.url, {
            method: "POST",
            body: "x".repeat(270000),
          }),
        )
      ).status,
    ).toBe(413);
    expect(await store.db.query("SELECT * FROM demo_jobs")).toHaveLength(0);
  });
  test("assistant failure remains queued and does not leak message text", async () => {
    configure();
    const tenant = await store.ensureTenant("whatsapp:12025550101");
    await store.db.query(
      "UPDATE demo_tenants SET status='active' WHERE id=$1",
      [tenant.id],
    );
    upstream = () => new Response(null, { status: 503 });
    expect((await app(incoming("wa-retry", "private message"))).status).toBe(
      200,
    );
    await settle();
    const [job] = await store.db.query<{ status: string; payload: string }>(
      "SELECT status,payload FROM demo_jobs WHERE id='whatsapp:wa-retry'",
    );
    expect(job?.status).toBe("pending");
    expect(job?.payload).not.toContain("private message");
    upstream = () => Response.json({ ok: true });
    await store.db.query("UPDATE demo_jobs SET available_at=now()");
    await worker.drain();
    expect(calls.at(-1)?.path).toBe("/webhooks/whatsapp");
  });
  test("verified email plus same-channel confirmation reuses the existing assistant", async () => {
    configure();
    const owner = await active();
    await store.db.query(
      "UPDATE demo_tenants SET email='user@example.com' WHERE id=$1",
      [owner.id],
    );
    await app(incoming());
    await settle();
    const newcomer = await store.ensureTenant("whatsapp:12025550101");
    const login = await signIn(newcomer);
    const callback = await app(
      new Request(
        `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${login.state}&code=test-code`,
        { headers: { cookie: login.cookie } },
      ),
    );
    const html = await callback.text();
    expect(html).toContain("Finish setup in WhatsApp");
    const token = decodeURIComponent(html.match(/text=([^"<]+)/)![1]!).slice(9);
    await app(incoming("wa-wrong", `/confirm ${token}`, "12025550102"));
    await settle();
    expect((await store.ensureTenant("whatsapp:12025550102")).status).toBe(
      "pending",
    );
    await app(incoming("wa-confirm", `/confirm ${token}`));
    await settle();
    expect((await store.ensureTenant("whatsapp:12025550101")).id).toBe(
      owner.id,
    );
    expect(provisioned).toHaveLength(0);
    await app(incoming("wa-chat", "What is on my calendar?"));
    await settle();
    const delivery = calls.find((c) => c.path === "/webhooks/whatsapp")!;
    expect(delivery.tenant.id).toBe(owner.id);
    expect(
      new Headers(delivery.options?.headers).get("x-hub-signature-256"),
    ).toBe(
      waSignature(String(delivery.options?.body), config.WHATSAPP_APP_SECRET!),
    );
    expect((await store.tenant(owner.id)).telegram_id).toBe("123");
  });
  test("a fresh email provisions one assistant and migration preserves channel links", async () => {
    configure();
    const tenant = await store.ensureTenant("whatsapp:12025550101");
    await store.approve(tenant.id, "new@example.com");
    await store.approve(tenant.id, "new@example.com");
    await worker.drain();
    expect(provisioned).toEqual([tenant.id]);
    await pg.exec(schemaSql);
    expect((await store.ensureTenant("whatsapp:12025550101")).id).toBe(
      tenant.id,
    );
  });
});

describe("Microsoft connector", () => {
  test("unconfigured Outlook does not reach the assistant", async () => {
    await active();
    await app(webhook(901, "/connect outlook"));
    await settle();
    expect(sent[0]?.text).toContain("not configured");
    expect(calls).toHaveLength(0);
  });
  test("routes Microsoft consent and callback to the original tenant", async () => {
    config.MICROSOFT_CLIENT_ID = "test-microsoft-client";
    config.MICROSOFT_CLIENT_SECRET = "test-microsoft-secret";
    const tenant = await active();
    await active("456");
    await app(webhook(902, "/connect outlook"));
    await settle();
    const link = sent[0]!.text.split(": ")[1]!;
    const consentPage = await (await app(new Request(link))).text();
    expect(consentPage).toContain("Connect Outlook");
    expect(consentPage).toContain("Continue with Microsoft");
    expect(consentPage).not.toContain("Continue with Google");
    upstream = (path) =>
      path === "/v1/oauth/apps"
        ? Response.json({ app: { id: "microsoft-app" } })
        : Response.json({
            auth_url:
              "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            state: "microsoft-test-state-12345",
          });
    const response = await app(
      new Request(link, {
        method: "POST",
        headers: { origin: config.PUBLIC_BASE_URL },
      }),
    );
    expect(response.status).toBe(303);
    expect(calls[0]?.tenant.id).toBe(tenant.id);
    expect(calls[1]?.path).toBe("/v1/oauth/apps/microsoft-app/connect");
    const body = JSON.parse(String(calls[1]?.options?.body));
    expect(body.scopes).toContain("Mail.Send");
    expect(body.scopes).toContain("Calendars.ReadWrite");
    expect(body.scopes).not.toContain("MailboxSettings.ReadWrite");
    const callback = `${config.PUBLIC_BASE_URL}/webhooks/oauth/callback?state=microsoft-test-state-12345&code=test-code`;
    expect((await app(new Request(callback))).status).toBe(403);
    upstream = () => Response.json({ ok: true });
    const completed = await app(
      new Request(callback, {
        headers: { cookie: response.headers.get("set-cookie")!.split(";")[0]! },
      }),
    );
    expect(completed.status).toBe(200);
    expect(calls.at(-1)?.tenant.id).toBe(tenant.id);
    const confirmation = await completed.text();
    expect(confirmation).toContain("Sign-in approved");
    expect(confirmation).toContain("still needs to verify access");
    expect(confirmation).not.toContain("Connection completed");
    expect(
      (
        await app(
          new Request(link, {
            method: "POST",
            headers: { origin: config.PUBLIC_BASE_URL },
          }),
        )
      ).status,
    ).toBe(400);
  });
  test("rejects an unexpected Microsoft authorization origin", async () => {
    config.MICROSOFT_CLIENT_ID = "test-client";
    config.MICROSOFT_CLIENT_SECRET = "test-secret";
    const tenant = await active();
    const ticket = await store.ticket(tenant.id, "connect", {
      provider: "outlook",
    });
    upstream = (path) =>
      path === "/v1/oauth/apps"
        ? Response.json({ app: { id: "microsoft-app" } })
        : Response.json({
            auth_url: "https://example.org/authorize",
            state: "test-state-123456789",
          });
    const response = await app(
      new Request(`${config.PUBLIC_BASE_URL}/connect?ticket=${ticket}`, {
        method: "POST",
        headers: { origin: config.PUBLIC_BASE_URL },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
  });
});

function miniData(id = 123, date = Math.floor(Date.now() / 1000)) {
  const fields = new URLSearchParams({
    auth_date: String(date),
    user: JSON.stringify({ id, first_name: "Example User" }),
    query_id: "test-query",
  });
  fields.sort();
  const secret = createHmac("sha256", "WebAppData")
    .update(config.TELEGRAM_BOT_TOKEN)
    .digest();
  fields.set(
    "hash",
    createHmac("sha256", secret)
      .update([...fields].map(([key, value]) => `${key}=${value}`).join("\n"))
      .digest("hex"),
  );
  return fields.toString();
}
function miniRequest(
  path: string,
  initData: string,
  session?: string,
  origin = config.PUBLIC_BASE_URL,
) {
  return new Request(`${config.PUBLIC_BASE_URL}/mini/${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ initData, session }),
  });
}

describe("Telegram Mini App", () => {
  test("additive schema update is idempotent and preserves existing tenants", async () => {
    const tenant = await store.ensureTenant("123");
    await pg.exec(schemaSql);
    await pg.exec(schemaSql);
    expect((await store.tenant(tenant.id)).telegram_id).toBe("123");
  });
  test("validates signed identity, freshness, duplicate fields and bot binding", () => {
    const raw = miniData();
    expect(verifyMiniIdentity(raw, config.TELEGRAM_BOT_TOKEN)).toBe("123");
    for (const invalid of [
      raw.replace("123", "456"),
      `${raw}&auth_date=1`,
      miniData(123, 1),
      miniData(123, Math.floor(Date.now() / 1000) + 100),
      "",
      miniData(-1),
    ]) {
      expect(() =>
        verifyMiniIdentity(invalid, config.TELEGRAM_BOT_TOKEN),
      ).toThrow();
    }
    expect(() => verifyMiniIdentity(raw, "another-bot-token")).toThrow();
  });
  test("Mini App alone permits Telegram framing and loads scoped assets", async () => {
    const response = await app(new Request(`${config.PUBLIC_BASE_URL}/mini`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'self' https://web.telegram.org",
    );
    expect(await response.text()).toContain("/mini/app.js");
    const regular = await app(new Request(`${config.PUBLIC_BASE_URL}/`));
    expect(regular.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
  test("rejects unsigned and cross-origin requests without creating tenants", async () => {
    expect((await app(miniRequest("session", "fake"))).status).toBe(403);
    expect(
      (
        await app(
          miniRequest(
            "session",
            miniData(),
            undefined,
            "https://other.example.com",
          ),
        )
      ).status,
    ).toBe(403);
    expect(await store.db.query("SELECT * FROM demo_tenants")).toHaveLength(0);
  });
  test("Google login completes only through the original verified Mini App session", async () => {
    const initData = miniData();
    const start = await app(miniRequest("session", initData));
    expect(start.status).toBe(200);
    const flow = (await start.json()) as { session: string; url: string };
    expect((await app(miniRequest("session", initData))).status).toBe(409);
    const waiting = await app(miniRequest("status", initData, flow.session));
    expect(await waiting.json()).toEqual({ status: "pending" });
    expect((await app(new Request(flow.url))).status).toBe(200);
    const login = await app(
      new Request(flow.url, {
        method: "POST",
        headers: { Origin: config.PUBLIC_BASE_URL },
      }),
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const callback = new Request(
      `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${state}&code=test`,
      { headers: { Cookie: cookie } },
    );
    const result = await app(callback.clone());
    expect(await result.text()).toContain("Setup finishes automatically");
    expect((await app(callback)).status).toBe(400);
    expect(provisioned).toHaveLength(0);
    expect(
      (await app(miniRequest("status", miniData(456), flow.session))).status,
    ).toBe(403);
    expect(provisioned).toHaveLength(0);
    expect(
      (await app(miniRequest("status", initData, flow.session))).status,
    ).toBe(200);
    await settle();
    await worker.drain();
    expect(provisioned).toHaveLength(1);
    expect(
      await (await app(miniRequest("status", initData, flow.session))).json(),
    ).toEqual({ status: "active" });
    await settle();
    expect(provisioned).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(
      await store.db.query("SELECT * FROM demo_tickets WHERE kind='confirm'"),
    ).toHaveLength(0);
  });
  test("expired Mini App sessions cannot complete setup", async () => {
    const initData = miniData();
    const flow = (await (
      await app(miniRequest("session", initData))
    ).json()) as { session: string };
    await store.db.query(
      "UPDATE demo_mini_sessions SET expires_at=now()-interval '1 minute'",
    );
    expect(
      (await app(miniRequest("status", initData, flow.session))).status,
    ).toBe(403);
    expect(provisioned).toHaveLength(0);
  });
  test("Mini App sign-in still rejects Google accounts outside the allowlist", async () => {
    const initData = miniData();
    const flow = (await (
      await app(miniRequest("session", initData))
    ).json()) as { session: string; url: string };
    const login = await app(
      new Request(flow.url, {
        method: "POST",
        headers: { Origin: config.PUBLIC_BASE_URL },
      }),
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    googleEmail = "other@example.com";
    expect(
      (
        await app(
          new Request(
            `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${state}&code=test`,
            { headers: { Cookie: cookie } },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      await (await app(miniRequest("status", initData, flow.session))).json(),
    ).toEqual({ status: "pending" });
    expect(provisioned).toHaveLength(0);
  });
});
afterAll(async () => {
  await pg.close();
});

describe("Telegram ingress and delivery", () => {
  test("rejects spoofed requests before storing anything", async () => {
    const request = webhook(1);
    request.headers.delete("x-telegram-bot-api-secret-token");
    expect((await app(request)).status).toBe(401);
    expect(await store.db.query("SELECT * FROM demo_tenants")).toHaveLength(0);
  });
  test("gates unknown senders without provisioning or inference", async () => {
    expect((await app(webhook(1))).status).toBe(200);
    await settle();
    expect(sent[0]?.text).toContain("/onboard?ticket=");
    expect(calls).toHaveLength(0);
    expect(provisioned).toHaveLength(0);
  });
  test("does not forward group or mismatched private identities", async () => {
    const req = webhook(1);
    const body = await req.json();
    body.message.chat.id = 456;
    expect(
      (
        await app(
          new Request(req.url, {
            method: "POST",
            headers: req.headers,
            body: JSON.stringify(body),
          }),
        )
      ).status,
    ).toBe(200);
    expect(await store.db.query("SELECT * FROM demo_tenants")).toHaveLength(0);
  });
  test("rejects actual oversized streamed bodies", async () => {
    const req = webhook(1);
    expect(
      (
        await app(
          new Request(req.url, {
            method: "POST",
            headers: req.headers,
            body: "x".repeat(270_000),
          }),
        )
      ).status,
    ).toBe(413);
  });
  test("routes each user to their own assistant", async () => {
    const a = await active("123");
    const b = await active("456");
    await app(webhook(1, "hello", 123));
    await settle();
    await app(webhook(2, "hello", 456));
    await settle();
    expect(calls.map((c) => c.tenant.id)).toEqual([a.id, b.id]);
    expect(calls.every((c) => c.path === "/webhooks/telegram")).toBe(true);
  });
  test("duplicate updates are delivered once and completed payloads are removed", async () => {
    await active();
    await app(webhook(1));
    await settle();
    await app(webhook(1));
    await settle();
    expect(calls).toHaveLength(1);
    const [job] = await store.db.query<{ payload: string }>(
      "SELECT payload FROM demo_jobs",
    );
    expect(job?.payload).toBe("");
  });
  test("bot cutover preserves tenants without colliding with legacy updates", async () => {
    const tenant = await active();
    await app(webhook(1));
    await settle();
    const secondConfig = readConfig({
      ...config,
      TELEGRAM_BOT_TOKEN: `456:${"x".repeat(32)}`,
      TELEGRAM_UPDATE_BOT_ID: "456",
    });
    const secondApp = createApp(secondConfig, store, runtime, worker, (work) => {
      background.push(work);
    }, (async (_input: string | URL | Request) => Response.json({ ok: true })) as typeof fetch);
    expect((await secondApp(webhook(1))).status).toBe(401);
    const replacementUpdate = () => {
      const request = webhook(1);
      request.headers.set("x-telegram-bot-api-secret-token", telegramWebhookSecret(secondConfig));
      return request;
    };
    await secondApp(replacementUpdate());
    await settle();
    await secondApp(replacementUpdate());
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.tenant.id === tenant.id)).toBe(true);
    expect(await store.db.query("SELECT id FROM demo_tenants")).toHaveLength(1);
  });
  test("update namespaces must match the configured bot", () => {
    expect(() => readConfig({
      ...config,
      TELEGRAM_BOT_TOKEN: `456:${"x".repeat(32)}`,
      TELEGRAM_UPDATE_BOT_ID: "789",
    })).toThrow("TELEGRAM_UPDATE_BOT_ID");
  });
  test("503 responses stay durable and retry", async () => {
    await active();
    upstream = () => new Response("unavailable", { status: 503 });
    await app(webhook(1));
    await settle();
    const [job] = await store.db.query<{ status: string; payload: string }>(
      "SELECT * FROM demo_jobs",
    );
    expect(job?.status).toBe("pending");
    expect(job?.payload).not.toContain("hello");
    upstream = () => Response.json({ ok: true });
    await store.db.query("UPDATE demo_jobs SET available_at=now()");
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(
      (
        await store.db.query<{ status: string }>("SELECT status FROM demo_jobs")
      )[0]?.status,
    ).toBe("done");
  });
  test("database failure never acknowledges a message", async () => {
    const failing = Object.create(store) as Store;
    failing.enqueue = async () => {
      throw new Error("database unavailable");
    };
    const handler = createApp(config, failing, runtime, worker, () => {});
    expect((await handler(webhook(1))).status).toBe(503);
  });
  test("acknowledges durable active messages once without waiting for assistant work", async () => {
    await active();
    const acknowledgements: unknown[] = [];
    const handler = createApp(config, store, runtime, worker, (work) => background.push(work),
      (async (_url, options) => {
        acknowledgements.push(JSON.parse(String(options?.body)));
        return Response.json({ ok: true });
      }) as typeof fetch);
    expect((await handler(webhook(501))).status).toBe(200);
    expect((await handler(webhook(501))).status).toBe(200);
    await settle();
    expect(acknowledgements).toEqual([{ chat_id: "123", action: "typing" }]);
  });
  test("acknowledgement failure does not lose the accepted message", async () => {
    await active();
    const handler = createApp(config, store, runtime, worker, (work) => background.push(work),
      (async (_input: string | URL | Request) => { throw new Error("unavailable"); }) as unknown as typeof fetch);
    expect((await handler(webhook(502))).status).toBe(200);
    await settle();
    expect((await store.db.query<{ status: string }>("SELECT status FROM demo_jobs WHERE id='telegram:502'"))[0]?.status).toBe("done");
  });
});

describe("Telegram bot cutover", () => {
  const replacement = { ...config, TELEGRAM_BOT_TOKEN: `456:${"x".repeat(32)}`, TELEGRAM_UPDATE_BOT_ID: "456" };
  test("migrates active tenants before registering a bot-specific webhook", async () => {
    const tenant = await active();
    const order: string[] = [];
    const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).endsWith("/getMe")) {
        order.push("identity");
        return Response.json({ ok: true, result: { id: 456 } });
      }
      order.push("register");
      expect(JSON.parse(String(options?.body))).toEqual({
        url: `${config.PUBLIC_BASE_URL}/webhooks/telegram`,
        secret_token: telegramWebhookSecret(replacement),
        allowed_updates: ["message", "edited_message", "callback_query"],
        drop_pending_updates: false,
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
    expect(await reconcileTelegramBot(replacement, store, { ...runtime, configureTelegram: async (t) => {
      expect(t.id).toBe(tenant.id);
      order.push("migrate");
    } }, fetcher)).toBe(true);
    expect(order).toEqual(["identity", "migrate", "register"]);
  });
  test("refuses to deliver pending legacy jobs through the replacement bot", async () => {
    const tenant = await active();
    await store.enqueue("telegram:1", tenant.id, "telegram", {});
    let touched = false;
    await expect(reconcileTelegramBot(replacement, store, runtime, (async (_input: string | URL | Request) => {
      touched = true;
      return Response.json({ ok: true });
    }) as typeof fetch)).rejects.toThrow("legacy-jobs-pending");
    expect(touched).toBe(false);
  });
  test("failed migration never registers the replacement webhook", async () => {
    await active();
    let fetched = 0;
    await expect(reconcileTelegramBot(replacement, store, { ...runtime, configureTelegram: async () => {
      throw new Error("migration failed");
    } }, (async (_input: string | URL | Request) => {
      fetched++;
      return Response.json({ ok: true, result: { id: 456 } });
    }) as typeof fetch)).rejects.toThrow("assistant-credentials");
    expect(fetched).toBe(1);
  });
});

describe("OAuth and identity binding", () => {
  test("bot lookup fails closed on errors and unsafe usernames", async () => {
    for (const response of [
      new Response("unavailable", { status: 503 }),
      Response.json({ ok: false }),
      Response.json({ ok: true, result: { username: "other/path" } }),
    ]) {
      await expect(
        botUsername(
          "test-only",
          (async (_input: string | URL | Request) => response) as typeof fetch,
        ),
      ).rejects.toThrow();
    }
  });
  test("form policy preserves origin without exposing ticket paths", async () => {
    const tenant = await store.ensureTenant("123");
    const raw = await store.ticket(tenant.id, "onboard");
    const response = await app(
      new Request(`${config.PUBLIC_BASE_URL}/onboard?ticket=${raw}`),
    );
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' https://accounts.google.com https://login.microsoftonline.com https://t.me;",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  test("rejects null origin without consuming onboarding ticket", async () => {
    const tenant = await store.ensureTenant("123");
    const raw = await store.ticket(tenant.id, "onboard");
    const response = await app(
      new Request(`${config.PUBLIC_BASE_URL}/onboard?ticket=${raw}`, {
        method: "POST",
        headers: { Origin: "null" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await store.peek(raw, "onboard")).toBeDefined();
  });
  test("link preview GET does not consume onboarding link", async () => {
    const tenant = await store.ensureTenant("123");
    const raw = await store.ticket(tenant.id, "onboard");
    expect(
      (
        await app(
          new Request(`${config.PUBLIC_BASE_URL}/onboard?ticket=${raw}`),
        )
      ).status,
    ).toBe(200);
    expect(await store.peek(raw, "onboard")).toBeDefined();
  });
  test("rejects cross-origin onboarding submissions", async () => {
    const tenant = await store.ensureTenant("123");
    const raw = await store.ticket(tenant.id, "onboard");
    expect(
      (
        await app(
          new Request(`${config.PUBLIC_BASE_URL}/onboard?ticket=${raw}`, {
            method: "POST",
            headers: { Origin: "https://evil.example.org" },
          }),
        )
      ).status,
    ).toBe(403);
  });
  test("Google sign-in requires the browser cookie", async () => {
    const tenant = await store.ensureTenant("123");
    const { state } = await signIn(tenant);
    expect(
      (
        await app(
          new Request(
            `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${state}&code=test`,
          ),
        )
      ).status,
    ).toBe(403);
  });
  test("uninvited Google account cannot provision", async () => {
    googleEmail = "other@example.com";
    const tenant = await store.ensureTenant("123");
    const { state, cookie } = await signIn(tenant);
    expect(
      (
        await app(
          new Request(
            `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${state}&code=test`,
            { headers: { Cookie: cookie } },
          ),
        )
      ).status,
    ).toBe(403);
    expect(await store.db.query("SELECT * FROM demo_jobs")).toHaveLength(0);
  });
  test("unverified Google email cannot provision", async () => {
    googleVerified = false;
    const tenant = await store.ensureTenant("123");
    const { state, cookie } = await signIn(tenant);
    expect(
      (
        await app(
          new Request(
            `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${state}&code=test`,
            { headers: { Cookie: cookie } },
          ),
        )
      ).status,
    ).toBe(403);
    expect(await store.db.query("SELECT * FROM demo_jobs")).toHaveLength(0);
  });
  test("public signup accepts an unlisted verified account but still requires Telegram confirmation", async () => {
    config.PUBLIC_SIGNUP = "true";
    try {
      googleEmail = "new-user@example.org";
      const tenant = await store.ensureTenant("123");
      const { state, cookie } = await signIn(tenant);
      const response = await app(new Request(
        `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${state}&code=test`,
        { headers: { Cookie: cookie } },
      ));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Finish setup in Telegram");
      expect((await store.tenant(tenant.id)).status).toBe("pending");
      expect(await store.db.query("SELECT * FROM demo_jobs")).toHaveLength(0);
    } finally { config.PUBLIC_SIGNUP = "false"; }
  });
  test("public signup still rejects unverified Google accounts", async () => {
    config.PUBLIC_SIGNUP = "true";
    try {
      googleEmail = "new-user@example.org";
      googleVerified = false;
      const tenant = await store.ensureTenant("123");
      const { state, cookie } = await signIn(tenant);
      const response = await app(new Request(
        `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${state}&code=test`,
        { headers: { Cookie: cookie } },
      ));
      expect(response.status).toBe(403);
      expect(await store.db.query("SELECT * FROM demo_jobs")).toHaveLength(0);
    } finally { config.PUBLIC_SIGNUP = "false"; }
  });
  test("complete sign-in, Telegram confirmation, provisioning, and first message", async () => {
    const tenant = await store.ensureTenant("123");
    const { state, cookie } = await signIn(tenant);
    const callback = new Request(
      `${config.PUBLIC_BASE_URL}/auth/google/callback?state=${state}&code=test`,
      { headers: { Cookie: cookie } },
    );
    const response = await app(callback.clone());
    const html = await response.text();
    const confirmation = html.match(
      /name="start" value="(confirm_[A-Za-z0-9_-]+)"/,
    )?.[1];
    expect(confirmation).toBeDefined();
    expect(confirmation!.length).toBeLessThanOrEqual(64);
    expect(html).toContain('action="https://t.me/example_bot"');
    expect(html).toContain("Finish setup in Telegram");
    expect(html).not.toContain("/confirm ");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "https://t.me",
    );
    expect(provisioned).toHaveLength(0);
    expect((await app(callback)).status).toBe(400);
    await app(webhook(1, `/start ${confirmation}`, 456));
    await settle();
    expect(provisioned).toHaveLength(0);
    await app(webhook(2, `/start ${confirmation}`));
    await settle();
    await worker.drain();
    expect(provisioned).toEqual([tenant.id]);
    await app(webhook(4, `/start ${confirmation}`));
    await settle();
    expect(provisioned).toEqual([tenant.id]);
    expect(calls).toHaveLength(0);
    expect(sent.at(-1)?.text).toContain("already ready");
    await app(webhook(3, "what is on my calendar?"));
    await settle();
    expect(calls[0]?.tenant.id).toBe(tenant.id);
  });
  test("legacy manual confirmations remain supported", async () => {
    const tenant = await store.ensureTenant("123");
    const raw = await store.ticket(tenant.id, "confirm", {
      email: "user@example.com",
    });
    await app(webhook(1, `/confirm ${raw}`));
    await settle();
    await worker.drain();
    expect(provisioned).toEqual([tenant.id]);
    expect(await store.peek(raw, "confirm")).toBeUndefined();
  });
  test("expired and malformed setup links cannot provision", async () => {
    const tenant = await store.ensureTenant("123");
    const raw = await store.ticket(tenant.id, "confirm", {
      email: "user@example.com",
    });
    await store.db.query(
      "UPDATE demo_tickets SET expires_at=now()-interval '1 minute'",
    );
    await app(webhook(1, `/start confirm_${raw}`));
    await settle();
    await app(webhook(2, "/start confirm_invalid"));
    await settle();
    expect(provisioned).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(sent.at(-1)?.text).toContain("Send /start to try again");
  });
  test("Gmail-only consent excludes calendar and unrelated Google scopes", async () => {
    const tenant = await active();
    const raw = await store.ticket(tenant.id, "connect", { provider: "google", service: "gmail" });
    upstream = () => Response.json({ auth_url: "https://accounts.google.com/o/oauth2/v2/auth", state: "gmail-only-test-state" });
    const response = await app(new Request(`${config.PUBLIC_BASE_URL}/connect?ticket=${raw}`, {
      method: "POST", headers: { Origin: config.PUBLIC_BASE_URL },
    }));
    expect(response.status).toBe(303);
    const consent = calls.find((call) => call.path.endsWith("/connect"))!;
    expect(JSON.parse(String(consent.options?.body)).scopes).toEqual([
      "openid", "email", "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });
  test("native Google callback routes using stored state and cannot replay", async () => {
    const tenant = await active();
    const raw = await store.ticket(tenant.id, "connect");
    upstream = () =>
      Response.json({
        auth_url:
          "https://accounts.google.com/o/oauth2/v2/auth?state=example-oauth-state",
        state: "example-oauth-state",
      });
    const response = await app(
      new Request(`${config.PUBLIC_BASE_URL}/connect?ticket=${raw}`, {
        method: "POST",
        headers: { Origin: config.PUBLIC_BASE_URL },
      }),
    );
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    upstream = () => new Response("Connected");
    const callback = new Request(
      `${config.PUBLIC_BASE_URL}/webhooks/oauth/callback?state=example-oauth-state&code=test`,
      { headers: { Cookie: cookie } },
    );
    expect((await app(callback.clone())).status).toBe(200);
    expect(calls.at(-1)?.path).toBe(
      "/webhooks/oauth/callback?state=example-oauth-state&code=test",
    );
    expect((await app(callback)).status).toBe(400);
  });
  test("temporary callback failure preserves state for retry", async () => {
    const tenant = await active();
    const nonce = "test-browser";
    const state = await store.ticket(tenant.id, "callback", {
      cookie: digest(nonce),
    });
    upstream = () => new Response("unavailable", { status: 503 });
    const response = await app(
      new Request(
        `${config.PUBLIC_BASE_URL}/webhooks/oauth/callback?state=${state}&code=test`,
        { headers: { Cookie: `demo_connect=${nonce}` } },
      ),
    );
    expect(response.status).toBe(503);
    expect(await store.peek(state, "callback")).toBeDefined();
  });
  test("an acknowledged consent denial never reports sign-in approval", async () => {
    const tenant = await active();
    const nonce = "test-browser";
    const state = await store.ticket(tenant.id, "callback", { cookie: digest(nonce) });
    upstream = () => Response.json({ ok: true });
    const response = await app(new Request(
      `${config.PUBLIC_BASE_URL}/webhooks/oauth/callback?state=${state}&error=access_denied`,
      { headers: { Cookie: `demo_connect=${nonce}` } },
    ));
    const html = await response.text();
    expect(html).toContain("Connection unsuccessful");
    expect(html).not.toContain("Sign-in approved");
    expect(await store.peek(state, "callback")).toBeUndefined();
  });
  test("consent resumes its original conversation once as an internal event", async () => {
    const tenant = await active();
    const nonce = "test-browser";
    const state = await store.ticket(tenant.id, "callback", {
      cookie: digest(nonce), provider: "google", conversationId: "conv-123",
      requestedAt: "2026-09-17T20:00:00.000Z",
    });
    upstream = () => Response.json({ accepted: true });
    const callback = new Request(
      `${config.PUBLIC_BASE_URL}/webhooks/oauth/callback?state=${state}&code=test`,
      { headers: { Cookie: `demo_connect=${nonce}` } },
    );
    const response = await app(callback.clone());
    expect(await response.text()).toContain("continue your request in chat");
    await Promise.all(background);
    const resumed = calls.filter((call) => call.path === "/v1/messages");
    expect(sent).toEqual([{
      id: tenant.telegram_id,
      text: "Google sign-in returned successfully. I’m checking access and continuing your request here.",
    }]);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.tenant.id).toBe(tenant.id);
    const body = JSON.parse(String(resumed[0]!.options?.body));
    expect(body).toMatchObject({ conversationId: "conv-123", hidden: true, scripted: true, clientMessageId: `oauth-resume:${digest(state)}` });
    expect(body.content).toContain("Do not say the connection is ready until the read succeeds");
    expect(body.content).toContain("2026-09-17T20:00:00.000Z");
    expect(body.content).toContain("not a newer unrelated topic");
    expect(body.content).toContain("later cancellation or revision");
    expect(body.content).not.toContain("code=test");
    expect((await app(callback)).status).toBe(400);
    await worker.drain();
    expect(calls.filter((call) => call.path === "/v1/messages")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
  test("callback ticket consumption and both jobs roll back together on a queue failure", async () => {
    const tenant = await active();
    const state = await store.ticket(tenant.id, "callback", { provider: "google" });
    let inserts = 0;
    const failingDb: Database = {
      query: store.db.query.bind(store.db),
      transaction: (fn) => store.db.transaction((tx) => fn({
        transaction: tx.transaction.bind(tx),
        query: async <T>(sql: string, args?: unknown[]) => {
          if (sql.includes("INSERT INTO demo_jobs") && ++inserts === 2) {
            throw new Error("queue unavailable");
          }
          return tx.query<T>(sql, args);
        },
      })),
    };
    const jobs = [
      { id: "notice", kind: "oauth_notice" as const, payload: { provider: "google", resuming: true } },
      { id: "resume", kind: "oauth_resume" as const, payload: { provider: "google", conversationId: "conv-123" } },
    ];
    const failingStore = new Store(failingDb, store.vault);
    await expect(failingStore.consumeWithJobs(state, "callback", jobs)).rejects.toThrow("queue unavailable");
    expect(await store.peek(state, "callback")).toBeDefined();
    expect(await store.db.query("SELECT id FROM demo_jobs")).toHaveLength(0);
    expect(await store.consumeWithJobs(state, "callback", jobs)).toBe(true);
    expect(await store.consumeWithJobs(state, "callback", jobs)).toBe(false);
    expect(await store.db.query("SELECT id FROM demo_jobs")).toHaveLength(2);
  });

  test("expired callback cannot enqueue receipts or continuations", async () => {
    const tenant = await active();
    const state = await store.ticket(tenant.id, "callback");
    await store.db.query("UPDATE demo_tickets SET expires_at=now()-interval '1 minute'");
    expect(await store.consumeWithJobs(state, "callback", [
      { id: "notice", kind: "oauth_notice", payload: { provider: "outlook", resuming: false } },
    ])).toBe(false);
    expect(await store.db.query("SELECT id FROM demo_jobs")).toHaveLength(0);
  });
  test("Outlook callback notifies chat even without a resumable conversation", async () => {
    const tenant = await active();
    const nonce = "test-browser";
    const state = await store.ticket(tenant.id, "callback", {
      cookie: digest(nonce), provider: "outlook",
    });
    upstream = () => Response.json({ accepted: true });
    await app(new Request(
      `${config.PUBLIC_BASE_URL}/webhooks/oauth/callback?state=${state}&code=test`,
      { headers: { Cookie: `demo_connect=${nonce}` } },
    ));
    await settle();
    expect(sent).toEqual([{
      id: tenant.telegram_id,
      text: "Microsoft sign-in returned successfully. Access still needs verification. You can continue here in chat.",
    }]);
    expect(calls.some((call) => call.path === "/v1/messages")).toBe(false);
    await pg.exec(schemaSql);
    expect(await store.db.query("SELECT id FROM demo_jobs WHERE kind='oauth_notice' AND status='done'")).toHaveLength(1);
  });
  test("receipt timing records accepted delivery without identity or message contents", async () => {
    const tenant = await active();
    await store.enqueue("receipt-timing", tenant.id, "oauth_notice", { provider: "google", resuming: true });
    const logged = spyOn(console, "info").mockImplementation(() => {});
    try {
      await worker.drain("oauth_notice");
      expect(logged).toHaveBeenCalledWith("OAuth receipt delivered", {
        provider: "google", channel: "telegram", attempt: 1,
        sendMs: expect.any(Number), queueToReceiptMs: expect.any(Number),
      });
      const evidence = JSON.stringify(logged.mock.calls);
      expect(evidence).not.toContain(tenant.telegram_id);
      expect(evidence).not.toContain("checking access");
    } finally {
      logged.mockRestore();
    }
  });

  test("declining consent cannot enqueue a continuation", async () => {
    const tenant = await active();
    const nonce = "test-browser";
    const state = await store.ticket(tenant.id, "callback", {
      cookie: digest(nonce), provider: "google", conversationId: "conv-123",
    });
    upstream = () => Response.json({ ok: true });
    await app(new Request(
      `${config.PUBLIC_BASE_URL}/webhooks/oauth/callback?state=${state}&error=access_denied`,
      { headers: { Cookie: `demo_connect=${nonce}` } },
    ));
    await worker.drain();
    expect(calls.some((call) => call.path === "/v1/messages")).toBe(false);
    expect(await store.db.query("SELECT id FROM demo_jobs WHERE kind='oauth_resume'")).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("worker recovery and secrets", () => {
  test("OAuth continuation retries keep the original conversation and idempotency key", async () => {
    const tenant = await active();
    const id = "oauth-resume:test-retry";
    await store.enqueue(id, tenant.id, "oauth_resume", {
      conversationId: "conv-123", provider: "google",
    });
    upstream = () => new Response("unavailable", { status: 503 });
    await worker.drain();
    const [pending] = await store.db.query<{ status: string; attempts: number; payload: string }>(
      "SELECT status,attempts,payload FROM demo_jobs WHERE id=$1", [id],
    );
    expect(pending?.status).toBe("pending");
    expect(pending?.attempts).toBe(1);
    expect(pending?.payload).not.toBe("");
    await store.db.query("UPDATE demo_jobs SET available_at=now() WHERE id=$1", [id]);
    upstream = () => Response.json({ accepted: true });
    await worker.drain();
    const attempts = calls.filter((call) => call.path === "/v1/messages")
      .map((call) => JSON.parse(String(call.options?.body)));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[1]).toMatchObject({ conversationId: "conv-123", clientMessageId: id, hidden: true, scripted: true });
    const [finished] = await store.db.query<{ status: string; payload: string }>(
      "SELECT status,payload FROM demo_jobs WHERE id=$1", [id],
    );
    expect(finished).toEqual({ status: "done", payload: "" });
  });
  test("only one job per tenant is leased at a time", async () => {
    const tenant = await active();
    await store.enqueue("a", tenant.id, "telegram", {});
    await store.enqueue("b", tenant.id, "telegram", {});
    expect(await store.claim()).toBeDefined();
    expect(await store.claim()).toBeUndefined();
  });
  test("callback receipt bypasses a busy conversation without starting another assistant turn", async () => {
    const tenant = await active();
    await store.enqueue("a", tenant.id, "telegram", {});
    await store.claim();
    await store.enqueue("b", tenant.id, "oauth_resume", { conversationId: "conv-123", provider: "google" });
    await store.enqueue("c", tenant.id, "oauth_notice", { provider: "google", resuming: true });
    await worker.drain("oauth_notice");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe(tenant.telegram_id);
    expect(calls).toHaveLength(0);
    expect(await store.claim()).toBeUndefined();
    expect(await store.db.query("SELECT id FROM demo_jobs WHERE id='b' AND status='pending'")).toHaveLength(1);
  });
  test("retry backoff preserves conversation order without blocking other tenants or receipts", async () => {
    const tenant = await active();
    const other = await store.ensureTenant("104");
    await store.enqueue("a", tenant.id, "telegram", {});
    const first = (await store.claim())!;
    await store.finish(first, true);
    await store.enqueue("b", tenant.id, "telegram", {});
    await store.enqueue("c", other.id, "telegram", {});
    await store.enqueue("d", tenant.id, "oauth_notice", { provider: "outlook", resuming: false });
    expect((await store.claim())?.id).toBe("c");
    await worker.drain("oauth_notice");
    expect(sent).toHaveLength(1);
    expect(await store.claim()).toBeUndefined();
    await store.db.query("UPDATE demo_jobs SET available_at=now() WHERE id='a'");
    const retry = (await store.claim())!;
    expect(retry.id).toBe("a");
    await store.finish(retry);
    expect((await store.claim())?.id).toBe("b");
  });
  test("provisioning does not block another tenant's chat but remains bounded", async () => {
    const first = await store.ensureTenant("101");
    const second = await store.ensureTenant("102");
    const third = await store.ensureTenant("103");
    await store.enqueue("a", first.id, "provision", {});
    const provision = (await store.claim())!;
    await store.enqueue("b", second.id, "provision", {});
    await store.enqueue("c", third.id, "telegram", {});
    await store.enqueue("d", first.id, "telegram", {});
    const chat = (await store.claim())!;
    expect(chat.id).toBe("c");
    expect(await store.claim()).toBeUndefined();
    await store.finish(provision);
    expect((await store.claim())?.id).toBe("b");
    expect((await store.claim())?.id).toBe("d");
  });
  test("expired lease recovers and old worker cannot overwrite it", async () => {
    const tenant = await active();
    await store.enqueue("a", tenant.id, "telegram", {});
    const first = (await store.claim())!;
    await store.db.query(
      "UPDATE demo_jobs SET lease_until=now()-interval '1 minute'",
    );
    const second = (await store.claim())!;
    expect(second.lease_token).not.toBe(first.lease_token);
    await store.finish(first);
    expect(
      (
        await store.db.query<{ status: string }>("SELECT status FROM demo_jobs")
      )[0]?.status,
    ).toBe("running");
    await store.finish(second);
    expect(
      (
        await store.db.query<{ status: string }>("SELECT status FROM demo_jobs")
      )[0]?.status,
    ).toBe("done");
  });
  test("tickets expire", async () => {
    const tenant = await active();
    const token = await store.ticket(tenant.id, "onboard");
    await store.db.query(
      "UPDATE demo_tickets SET expires_at=now()-interval '1 minute'",
    );
    expect(await store.consume(token, "onboard")).toBeUndefined();
  });
  test("encryption binds secrets to their tenant", () => {
    const sealed = store.vault.seal({ token: "example-secret" }, "tenant-a");
    expect(sealed).not.toContain("example-secret");
    expect(store.vault.open<{ token: string }>(sealed, "tenant-a")).toEqual({
      token: "example-secret",
    });
    expect(() => store.vault.open(sealed, "tenant-b")).toThrow();
  });
  test("cron cannot be triggered without the worker secret", async () => {
    expect(
      (await app(new Request(`${config.PUBLIC_BASE_URL}/jobs/drain`))).status,
    ).toBe(401);
  });
  test("admin status requires authentication and omits sensitive tenant fields", async () => {
    const tenant = await active();
    await store.enqueue("telegram:1", tenant.id, "telegram", {
      text: "private-message",
    });
    expect(
      (await app(new Request(`${config.PUBLIC_BASE_URL}/admin/status`))).status,
    ).toBe(401);
    const response = await app(
      new Request(`${config.PUBLIC_BASE_URL}/admin/status`, {
        headers: { Authorization: `Bearer ${config.CRON_SECRET}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body.tenants[0]).sort()).toEqual([
      "id",
      "sandbox_id",
      "status",
    ]);
    expect(body.jobs).toEqual([{ status: "pending", count: 1 }]);
    expect(JSON.stringify(body)).not.toContain("private-message");
  });
});

describe("Daytona adapter", () => {
  const token = "guardian-example-token-with-sufficient-length";
  function sandbox(state = "started") {
    const executions: string[] = [];
    let starts = 0;
    const fake = {
      id: "sandbox-example",
      state,
      async start() {
        starts++;
        fake.state = "started";
      },
      async getPreviewLink() {
        return {
          url: "https://7830-sandbox.example.com",
          token: "private-preview-token",
        };
      },
      process: {
        async executeCommand(command: string) {
          executions.push(command);
          return {
            exitCode: 0,
            result: command.includes("--wake")
              ? `DEMO_TOKEN=${JSON.stringify({ guardianToken: token })}`
              : `DEMO_RESULT=${JSON.stringify({ guardianToken: token, webhookSecret: "w".repeat(32), port: 7830, googleAppId: "google-app" })}`,
          };
        },
      },
    };
    return {
      fake: fake as unknown as Sandbox,
      executions,
      starts: () => starts,
    };
  }
  async function ready() {
    const t = await active();
    await store.db.query(
      "UPDATE demo_tenants SET sandbox_id=$2,secrets=$3 WHERE id=$1",
      [
        t.id,
        "sandbox-example",
        store.vault.seal(
          { guardianToken: token, webhookSecret: "w".repeat(32), port: 7830 },
          t.id,
        ),
      ],
    );
    return store.tenant(t.id);
  }
  test("optional connection setup failure does not drop a chat message and retries later", async () => {
    config.MICROSOFT_CLIENT_ID = "test-client";
    config.MICROSOFT_CLIENT_SECRET = "test-secret";
    const t = await ready();
    const box = sandbox();
    const paths: string[] = [];
    const client = { get: async () => box.fake } as unknown as Pick<
      Daytona,
      "get" | "create"
    >;
    const adapter = new DaytonaRuntime(config, store, client, async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return new Response(null, {
        status: path === "/v1/credentials/set" ? 400 : 200,
      });
    });
    expect((await adapter.request(t, "/webhooks/telegram")).status).toBe(200);
    expect((await adapter.request(t, "/webhooks/telegram")).status).toBe(200);
    expect(paths.filter((p) => p === "/v1/credentials/set")).toHaveLength(2);
    expect(paths.filter((p) => p === "/webhooks/telegram")).toHaveLength(2);
  });
  test("Telegram installs partner workflows before forwarding and caches successful setup", async () => {
    const t = await ready();
    const box = sandbox();
    const hosted = partnerHarness();
    const client = { get: async () => box.fake } as unknown as Pick<Daytona, "get" | "create">;
    let messages = 0;
    const adapter = new DaytonaRuntime(config, store, client, async (url, options) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname + parsed.search;
      if (path === "/v1/credentials/set") { return new Response(null, { status: 503 }); }
      if (path === "/webhooks/telegram") {
        expect(hosted.state(t.id).files.has("skills/hosted-partner-workflows-v1/scripts/time-entries.ts")).toBe(true);
        expect(hosted.state(t.id).heartbeat).toContain("Partner workflow review");
        messages++;
        return Response.json({ ok: true });
      }
      return hosted.runtime.request(t, path, options);
    });
    await adapter.request(t, "/webhooks/telegram");
    const installedCalls = hosted.calls.length;
    await adapter.request(t, "/webhooks/telegram");
    expect(messages).toBe(2);
    expect(hosted.calls.length).toBe(installedCalls);
  });
  test("Telegram retries a failed partner installation without dropping either message", async () => {
    const t = await ready();
    const box = sandbox();
    const hosted = partnerHarness();
    hosted.fail("/v1/memory/v3/rebuild-index");
    const client = { get: async () => box.fake } as unknown as Pick<Daytona, "get" | "create">;
    let messages = 0;
    const adapter = new DaytonaRuntime(config, store, client, async (url, options) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname + parsed.search;
      if (path === "/v1/credentials/set") { return new Response(null, { status: 503 }); }
      if (path === "/webhooks/telegram") { messages++; return Response.json({ ok: true }); }
      return hosted.runtime.request(t, path, options);
    });
    await adapter.request(t, "/webhooks/telegram");
    hosted.fail();
    await adapter.request(t, "/webhooks/telegram");
    expect(messages).toBe(2);
    const manifest = hosted.state(t.id).files.get("skills/hosted-partner-workflows-v1/installation.json");
    expect(JSON.parse(manifest!).fingerprint).toBeString();
  });
  test("operator opt-in applies interactive auto-approval once before chat without changing background policy", async () => {
    config.HOSTED_INTERACTIVE_AUTO_APPROVE = "true";
    const t = await ready();
    const box = sandbox();
    const requests: { path: string; body: unknown; auth: string | null }[] = [];
    const client = { get: async () => box.fake } as unknown as Pick<
      Daytona,
      "get" | "create"
    >;
    const adapter = new DaytonaRuntime(
      config,
      store,
      client,
      async (url, options) => {
        const path = new URL(String(url)).pathname;
        requests.push({
          path,
          body: options?.body ? JSON.parse(String(options.body)) : null,
          auth: new Headers(options?.headers).get("authorization"),
        });
        if (path === "/v1/skills/hosted-partner-workflows-v1") { return new Response(null, { status: 503 }); }
        return Response.json({
          interactive: "high",
          autonomous: "low",
          headless: "none",
        });
      },
    );
    await adapter.request(t, "/webhooks/telegram");
    await adapter.request(t, "/webhooks/whatsapp");
    expect(requests.map((r) => r.path)).toEqual([
      "/v1/permissions/thresholds",
      "/v1/credentials/set",
      "/v1/skills/hosted-outlook-connect-v1",
      "/v1/skills/hosted-legal-review-v3",
      "/v1/skills/hosted-connections-policy-v2",
      "/v1/skills/hosted-outlook-connect-v1/files/content",
      "/v1/skills/hosted-legal-review-v3/files/content",
      "/v1/skills/hosted-connections-policy-v2/files/content",
      "/v1/workspace/write",
      "/v1/workspace/write",
      "/v1/workspace/write",
      "/v1/memory/v2/reembed-skills",
      "/v1/memory/v3/rebuild-index",
      "/v1/skills/hosted-partner-workflows-v1",
      "/webhooks/telegram",
      "/webhooks/whatsapp",
    ]);
    expect(requests[0]?.body).toEqual({ interactive: "high" });
    expect(requests[0]?.auth).toBe(`Bearer ${token}`);
  });
  test("policy setup failure preserves queued work and retries without forwarding a prompt-producing turn", async () => {
    config.HOSTED_INTERACTIVE_AUTO_APPROVE = "true";
    const t = await ready();
    const box = sandbox();
    const paths: string[] = [];
    let failures = 1;
    const client = { get: async () => box.fake } as unknown as Pick<
      Daytona,
      "get" | "create"
    >;
    const adapter = new DaytonaRuntime(config, store, client, async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/v1/permissions/thresholds" && failures-- > 0) {
        return Response.json({ error: "unavailable" }, { status: 400 });
      }
      if (path === "/v1/skills/hosted-partner-workflows-v1") { return new Response(null, { status: 503 }); }
      return Response.json({ interactive: "high" });
    });
    await expect(adapter.request(t, "/webhooks/telegram")).rejects.toThrow(
      "Hosted interactive policy setup failed",
    );
    expect(paths).toEqual(["/v1/permissions/thresholds"]);
    await adapter.request(t, "/webhooks/telegram");
    expect(paths).toEqual([
      "/v1/permissions/thresholds",
      "/v1/permissions/thresholds",
      "/v1/credentials/set",
      "/v1/skills/hosted-outlook-connect-v1",
      "/v1/skills/hosted-legal-review-v3",
      "/v1/skills/hosted-connections-policy-v2",
      "/v1/skills/hosted-outlook-connect-v1/files/content",
      "/v1/skills/hosted-legal-review-v3/files/content",
      "/v1/skills/hosted-connections-policy-v2/files/content",
      "/v1/workspace/write",
      "/v1/workspace/write",
      "/v1/workspace/write",
      "/v1/memory/v2/reembed-skills",
      "/v1/memory/v3/rebuild-index",
      "/v1/skills/hosted-partner-workflows-v1",
      "/webhooks/telegram",
    ]);
  });
  test("creates private persistent sandboxes with sleeping disabled", async () => {
    const t = await store.ensureTenant("123");
    const box = sandbox();
    let options: Record<string, unknown> | undefined;
    const client = {
      async get() {
        throw new DaytonaNotFoundError("missing", 404);
      },
      async create(params: Record<string, unknown>) {
        options = params;
        return box.fake;
      },
    } as unknown as Pick<Daytona, "get" | "create">;
    await new DaytonaRuntime(config, store, client).provision(t);
    expect(options?.public).toBe(false);
    expect(options?.autoStopInterval).toBe(0);
    expect(options?.autoPauseInterval).toBe(0);
    expect(options?.autoDeleteInterval).toBe(-1);
    const saved = await store.tenant(t.id);
    expect(saved.status).toBe("active");
    expect(saved.secrets).not.toContain(token);
  });
  test("does not recreate a previously assigned sandbox if it disappears", async () => {
    const t = await ready();
    let creates = 0;
    const client = {
      async get() {
        throw new DaytonaNotFoundError("missing", 404);
      },
      async create() {
        creates++;
        return sandbox().fake;
      },
    } as unknown as Pick<Daytona, "get" | "create">;
    await expect(
      new DaytonaRuntime(config, store, client).provision(t),
    ).rejects.toThrow();
    expect(creates).toBe(0);
  });
  test("forwards only to gateway with private preview and Telegram credentials", async () => {
    const t = await ready();
    const box = sandbox();
    let outgoing: Headers | undefined;
    const client = {
      async get() {
        return box.fake;
      },
      async create() {
        throw new Error("Unexpected create");
      },
    };
    const adapter = new DaytonaRuntime(config, store, client, (async (
      _url,
      options,
    ) => {
      outgoing = new Headers(options?.headers);
      return Response.json({ ok: true });
    }) as typeof fetch);
    await adapter.request(t, "/webhooks/telegram", {
      method: "POST",
      body: "{}",
    });
    expect(outgoing?.get("x-daytona-preview-token")).toBe(
      "private-preview-token",
    );
    expect(outgoing?.get("x-telegram-bot-api-secret-token")).toBe(
      "w".repeat(32),
    );
    expect(outgoing?.get("authorization")).toBeNull();
  });
  test("applies the second-in-command intro once before forwarding", async () => {
    const t = await ready();
    const box = sandbox();
    const client = { get: async () => box.fake } as unknown as Pick<
      Daytona,
      "get" | "create"
    >;
    const adapter = new DaytonaRuntime(config, store, client, async () =>
      Response.json({ ok: true }),
    );
    await adapter.request(t, "/webhooks/telegram");
    await adapter.request(t, "/webhooks/telegram");
    expect(
      box.executions.filter((command) => command.includes("INTRO_SOUL_OLD")),
    ).toHaveLength(1);
    expect(box.executions.find((command) => command.includes("INTRO_SOUL_OLD"))).toContain("INTRO_LENGTH_OLD");
    expect(box.executions.find((command) => command.includes("INTRO_SOUL_OLD"))).toContain("INTRO_LENGTH_NEW");
  });
  test("restarts saved assistant processes after sandbox restart", async () => {
    const t = await ready();
    const box = sandbox("stopped");
    const client = {
      async get() {
        return box.fake;
      },
      async create() {
        throw new Error("Unexpected create");
      },
    };
    await new DaytonaRuntime(config, store, client, async () =>
      Response.json({ ok: true }),
    ).request(t, "/webhooks/telegram");
    expect(box.starts()).toBe(1);
    expect(box.executions[0]).toBe("bun /opt/vellum-demo/bootstrap.ts --wake");
    expect(box.executions[1]).toContain("INTRO_SOUL_OLD");
  });
  test("bot migration updates only Telegram credentials and checkpoints after restart", async () => {
    const t = await ready();
    const original = store.vault.open<Record<string, unknown>>(t.secrets!, t.id);
    const box = sandbox();
    const requests: { path: string; body?: unknown }[] = [];
    const replacement = { ...config, TELEGRAM_BOT_TOKEN: `456:${"x".repeat(32)}`, TELEGRAM_UPDATE_BOT_ID: "456" };
    const adapter = new DaytonaRuntime(replacement, store, {
      get: async () => box.fake,
      create: async () => { throw new Error("Must preserve existing sandbox"); },
    }, async (url, options) => {
      requests.push({ path: new URL(String(url)).pathname, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      return Response.json({ ok: true });
    });
    await adapter.configureTelegram(t);
    expect(requests).toEqual([
      { path: "/v1/credentials/set", body: { service: "telegram", field: "bot_token", value: replacement.TELEGRAM_BOT_TOKEN } },
      { path: "/healthz", body: undefined },
    ]);
    expect(box.executions).toContain("bun /opt/vellum/cli/src/index.ts sleep hosted-demo");
    expect(box.executions).toContain("bun /opt/vellum-demo/bootstrap.ts --wake");
    const fresh = await store.tenant(t.id);
    expect(fresh.google_app_id).toBe(t.google_app_id);
    expect(fresh.sandbox_id).toBe(t.sandbox_id);
    expect(store.vault.open<Record<string, unknown>>(fresh.secrets!, t.id)).toEqual({ ...original, telegramTokenDigest: digest(replacement.TELEGRAM_BOT_TOKEN) });
    await adapter.configureTelegram(fresh);
    expect(requests).toHaveLength(2);
  });
  test("failed credential migration does not stop the assistant or checkpoint success", async () => {
    const t = await ready();
    const original = t.secrets;
    const box = sandbox();
    const adapter = new DaytonaRuntime({ ...config, TELEGRAM_UPDATE_BOT_ID: "456" }, store, {
      get: async () => box.fake,
      create: async () => { throw new Error("Must preserve existing sandbox"); },
    }, async () => new Response(null, { status: 400 }));
    await expect(adapter.configureTelegram(t)).rejects.toThrow("credential update failed");
    expect((await store.tenant(t.id)).secrets).toBe(original);
    expect(box.executions.some((command) => command.includes(" sleep "))).toBe(false);
  });
  test("cannot leak sandbox credentials to an arbitrary URL", async () => {
    const t = await ready();
    const box = sandbox();
    let requests = 0;
    const client = {
      async get() {
        return box.fake;
      },
      async create() {
        throw new Error("Unexpected create");
      },
    };
    await expect(
      new DaytonaRuntime(config, store, client, async () => {
        requests++;
        return new Response();
      }).request(t, "https://evil.example.org/collect"),
    ).rejects.toThrow("Invalid gateway path");
    expect(requests).toBe(0);
  });
});
