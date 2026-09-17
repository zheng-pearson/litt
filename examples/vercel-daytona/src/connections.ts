import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Runtime } from "./runtime.js";
import { equalSecret, HttpError, limitedJson } from "./security.js";
import type { Store, Tenant } from "./store.js";
import { connectionRoutingSkill, legalReviewSkill, pearsonRecallSkill, writeHostedSkill } from "./hosted-skills.js";

export function connectionToken(config: Config, tenantId: string): string {
  const signature = createHmac("sha256", Buffer.from(config.ENCRYPTION_KEY, "hex"))
    .update(`hosted-connections:v1:${tenantId}`).digest("base64url");
  return `${tenantId}.${signature}`;
}

export async function connectionRoute(req: Request, config: Config, store: Store): Promise<Response | undefined> {
  if (new URL(req.url).pathname !== "/integrations/connect" || req.method !== "POST") {
    return undefined;
  }
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const tenantId = token.split(".")[0] ?? "";
  if (!z.uuid().safeParse(tenantId).success || !equalSecret(token, connectionToken(config, tenantId))) {
    throw new HttpError(401, "Unauthorized");
  }
  const parsed = z.object({ provider: z.enum(["outlook", "google", "pearson"]), service: z.enum(["gmail", "calendar", "both"]).optional(), conversationId: z.string().min(1).max(200).optional() }).strict().safeParse(await limitedJson(req, 1024));
  if (!parsed.success) { throw new HttpError(400, "Unsupported connection request"); }
  if (parsed.data.provider !== "google" && parsed.data.service) {
    throw new HttpError(400, "Service selection is only supported for Google");
  }
  const tenant = await store.tenant(tenantId);
  if (tenant.id !== tenantId || tenant.status !== "active") {
    throw new HttpError(403, "Assistant is not active");
  }
  if (parsed.data.provider === "outlook" && (!config.MICROSOFT_CLIENT_ID || !config.MICROSOFT_CLIENT_SECRET)) {
    throw new HttpError(503, "Outlook connection is not configured");
  }
  if (parsed.data.provider === "google" && !tenant.google_app_id) {
    throw new HttpError(503, "Google connection is not configured");
  }
  if (parsed.data.provider === "pearson" && !config.PEARSON_MCP_URL) { throw new HttpError(503, "Pearson connection is not configured"); }
  const ticket = await store.ticket(tenant.id, "connect", {
    ...parsed.data,
    ...(parsed.data.conversationId ? { requestedAt: new Date().toISOString() } : {}),
  });
  return Response.json({ url: `${config.PUBLIC_BASE_URL}/connect?ticket=${ticket}`, expires_in: 600 });
}

export async function installConnectionSkill(config: Config, tenant: Tenant, runtime: Runtime): Promise<void> {
  const saved = await runtime.request(tenant, "/v1/credentials/set", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: "hosted-connections", field: "token", value: connectionToken(config, tenant.id) }),
  });
  if (!saved.ok) { throw new Error("Connection capability setup failed"); }
  const skillId = "hosted-outlook-connect-v1";
  const endpoint = `${config.PUBLIC_BASE_URL}/integrations/connect`.replaceAll("'", "'\\''");
  const definition = {
      skillId,
      name: "Hosted email and calendar connections",
      description: "Use for Gmail, Google Calendar or Outlook connection/status questions. If disconnected, include a secure sign-in link in the same reply, not an offer to send one. Verify service access with a read; resume the original task after consent.",
      bodyMarkdown: `# Connect email and calendar in chat

Treat questions such as "have you connected to Gmail?" as an opportunity to complete setup. Check current access; if the requested service is not connected, create and include its secure sign-in link in the same reply. Do not ask the user to say "connect Gmail" or confirm that they want a link. The browser consent screen is where they choose whether to grant access. Respect an explicit request for status only or not to connect. An earlier disconnect must remain in effect, but a later connection question can receive an optional sign-in link: creating the link does not reconnect the account or grant access. Preserve any existing mail/calendar task; do not invent a follow-on task when the user only asked about connection status.

Connection claims must come from current provider status and an actual service read, not earlier messages, memory, or proactive-check records. A past expiration is historical after a successful read. Distinguish expired access tokens that can refresh from a failed refresh requiring consent. On proven consent failure, include a fresh hosted sign-in link immediately. For timeouts or service outages, state that access could not be verified and retry without claiming the account is disconnected.

Include conversationId from the __CONVERSATION_ID environment variable in the link request JSON. Do not invent an ID or ask the user to supply one. ${config.OAUTH_AUTOMATIC_RESUME === "true" ? "The hosted service resumes this conversation automatically after consent. Tell the user the result will arrive in chat; do not require a done message." : "After consent, ask the user to return to this chat to continue; automatic continuation is not enabled."} The callback is an internal event, not new authorization to send email or modify calendar events.

For Google, use the hosted link request below with JSON {"provider":"google","service":"gmail"} for reading email, service calendar for calendar access, or service both when the user wants both or asks generally to connect Google. Send the returned link directly without requiring a slash command. Never tell a chat user to run a terminal command, open a local browser on the server, or configure an OAuth app. Do not invoke the generic Google OAuth connect command: it requests unrelated Drive, contacts, settings and send permissions. Gmail consent requests read access only; calendar consent requests event access only.

An active OAuth connection proves authentication, not Gmail API access. After consent, use the messaging skill to perform the requested Gmail read before saying Gmail is ready, then resume the user's original request. Preserve the actual provider error: SERVICE_DISABLED or accessNotConfigured is an operator-side Google Cloud API configuration problem, not something reconnecting can fix. Only report missing scopes if the granted scopes or a distinct insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT error proves it. Do not combine these diagnoses speculatively. For a proven scope problem, issue the hosted reconnect link; for a disabled API, explain briefly that the service setup needs repair without asking the user to use a developer console.

This hosted assistant has an operator-configured Microsoft app. Do not ask the user for client credentials, a slash command, or a separate Connections settings screen.

For Inbox reads, searches, drafts, and replies, load the existing messaging skill with the Outlook provider. Use the existing outlook-calendar skill for calendar operations. Check available skills before proposing installation; an ordinary Inbox read does not require installing a separate Outlook skill.

When the user explicitly asks to set their timezone, persist the IANA value with \`assistant config set ui.userTimezone "<IANA timezone>"\` and read it back with \`assistant config get ui.userTimezone\`. Memory alone does not configure the assistant's clock. Do not assume the server timezone is the user's timezone.

Before querying a relative calendar date such as today or tomorrow, resolve the literal local date mechanically in the configured timezone. On this hosted Linux assistant, run \`user_tz="$(assistant config get ui.userTimezone)"; TZ="$user_tz" date +%F; TZ="$user_tz" date -d tomorrow +%F\` and use the applicable returned date for the calendar bounds. Do not derive the date from UTC, reuse a date from earlier chat context, or do the date arithmetic mentally.

The hosted link works in Telegram and WhatsApp, including when an account is already connected. Do not disconnect an existing account to create a link. This is an ordinary browser link, not a managed UI surface.

For the link request and Outlook mail/calendar scripts, use bash with \`network_mode: "proxied"\`. These commands perform network requests in the CLI process; the default offline mode can hang until the command timeout. Keep credential values out of output.

Use \`assistant oauth status outlook\` to find the stored account, then \`assistant oauth ping outlook\` to test current authentication through the shared connection resolver and automatic token refresh. Status alone lists metadata; an access-token expiry timestamp is not proof that a refreshable connection is disconnected. When several accounts exist, use the intended account consistently. A successful ping verifies authentication only: perform the requested mail/calendar read to verify that service. Interactive requests and background reviews must use these same commands rather than a separate cached connection flag. If the user asks to connect/reconnect, or current evidence proves Outlook is disconnected, request a fresh sign-in link:

\`\`\`sh
curl --fail-with-body --silent --show-error -X POST '${endpoint}' -H "Authorization: Bearer $(assistant credentials reveal --service hosted-connections --field token)" -H 'Content-Type: application/json' --data "$(bun -e 'console.log(JSON.stringify({provider:"outlook",conversationId:process.env.__CONVERSATION_ID}))')"
\`\`\`

Send the returned URL as a clickable link in your reply. Explain briefly that the user signs in to Microsoft and approves mail/calendar access. The link expires in ten minutes and is single-use; request another when needed. Never print or send the capability credential itself. If the request fails, report that connection setup failed, not that Outlook is connected.

Remember the user's original task. After they return from consent, check connection health and perform an actual Outlook read before confirming access. Resume the original task with the Outlook mail/calendar skills. For latest inbox messages, read the Inbox folder; zero keyword-search matches do not mean an empty inbox. Interpret calendar dateTime together with its timeZone, convert to the user's timezone including the date, and never relabel UTC as local time. Private appointments require sensitivity=private; an empty attendee list is not privacy. Verify sent mail in Sent Items and requested changes by reading the changed item. Do not infer mailbox contents or free time from chat history. Connection consent does not itself authorize sending mail or changing events; follow the user's requested action and approval boundaries.
`,
    };
  const changed = await Promise.all(
    [definition, legalReviewSkill, connectionRoutingSkill, ...(config.PEARSON_MCP_URL ? [pearsonRecallSkill(config.PUBLIC_BASE_URL)] : [])].map((skill) => writeHostedSkill(tenant, runtime, skill)),
  );
  const needsWrite = changed.some(Boolean);
  if (!needsWrite) {
    return;
  }
  for (const path of ["/v1/memory/v2/reembed-skills", "/v1/memory/v3/rebuild-index"]) {
    const refreshed = await runtime.request(tenant, path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!refreshed.ok) { throw new Error("Connection skill discovery refresh failed"); }
  }
}
