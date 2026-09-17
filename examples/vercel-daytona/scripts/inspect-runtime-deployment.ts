import { Daytona } from "@daytona/sdk";
import { readConfig } from "../src/config.js";
import { database } from "../src/store.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/security.js";
import { DaytonaRuntime } from "../src/runtime.js";

if (process.env.VERCEL_ENV !== "production") {
  throw new Error("Runtime inspection requires the production environment");
}
const config = readConfig();
const db = database(config.DATABASE_URL);
const client = new Daytona({ apiKey: config.DAYTONA_API_KEY, target: config.DAYTONA_TARGET });
const ticketHash = process.env.INSPECT_CONNECTION_TICKET_HASH;
if (ticketHash && !/^[a-f0-9]{64}$/.test(ticketHash)) {
  throw new Error("Invalid inspection ticket hash");
}
const tenants = await db.query<{ id: string; sandbox_id: string }>(
  `SELECT id,sandbox_id FROM demo_tenants WHERE status='active' AND sandbox_id IS NOT NULL AND merged_into IS NULL
   AND ($1::text IS NULL OR id=(SELECT tenant_id FROM demo_tickets WHERE hash=$1 AND kind='connect'))`,
  [ticketHash ?? null],
);
if (ticketHash && tenants.length !== 1) { throw new Error("Inspection target could not be resolved uniquely"); }
for (const tenant of tenants) {
  const sandbox = await client.get(tenant.sandbox_id);
  const result = await sandbox.process.executeCommand(
    "sha256sum assistant/src/credential-health/credential-health-service.ts assistant/src/heartbeat/heartbeat-service.ts assistant/src/notifications/emit-signal.ts assistant/src/notifications/broadcaster.ts",
    "/opt/vellum",
    {},
    20,
  );
  if (result.exitCode !== 0 || !result.result.trim().split("\n").every((line) => /^[a-f0-9]{64}  assistant\/src\/[a-z/-]+\.ts$/.test(line))) {
    throw new Error("Unable to verify runtime source hashes");
  }
  console.log(JSON.stringify({ tenant: tenant.id, runtimeSourceHashes: result.result.trim().split("\n") }));
  if (ticketHash) {
    const store = new Store(db, new Vault(config.ENCRYPTION_KEY));
    const current = await store.tenant(tenant.id);
    const runtime = new DaytonaRuntime(config, store, client);
    const outlookStatus = await runtime.request(current, "/v1/oauth/status?provider=outlook");
    const outlookState = outlookStatus.ok ? await outlookStatus.json() as { connections?: Array<{ status?: string; hasRefreshToken?: boolean }> } : {};
    console.log(JSON.stringify({ outlookConnectionEvidence: {
      status: outlookStatus.status,
      activeConnections: outlookState.connections?.filter((entry) => entry.status?.toLowerCase() === "active").length,
      refreshAvailable: outlookState.connections?.some((entry) => entry.hasRefreshToken === true),
    } }));
    for (const [service, url] of [
      ["inbox", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=1&$select=id"],
      ["calendar", "https://graph.microsoft.com/v1.0/me/events?$top=1&$select=id"],
    ]) {
      const checked = await runtime.request(current, "/v1/oauth/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "outlook", method: "GET", url }),
      });
      const evidence = checked.ok ? await checked.json() as { ok?: boolean; status?: number } : {};
      console.log(JSON.stringify({ outlookReadEvidence: { service, routeStatus: checked.status, success: evidence.ok, providerStatus: evidence.status } }));
    }
    const soulResponse = await runtime.request(current, "/v1/workspace/file?path=SOUL.md");
    const soul = soulResponse.ok ? await soulResponse.json() as { content?: string } : {};
    console.log(JSON.stringify({ soulStatus: soulResponse.status, hasOldMessagingCap: soul.content?.includes("MUST NEVER EXCEED 2 sentences") ?? false, hasOldResponseCap: soul.content?.includes("MUST NEVER EXCEED 3 sentences") ?? false, hasTaskCompleteBrevity: soul.content?.includes("brevity must not omit required facts") ?? false }));
    const legalResponse = await runtime.request(current, "/v1/skills/hosted-legal-review-v2/files/content?path=SKILL.md");
    const legal = legalResponse.ok ? await legalResponse.json() as { content?: string } : {};
    console.log(JSON.stringify({ legalSkillStatus: legalResponse.status, hasUpdatedBriefGuidance: legal.content?.includes("updated brief still needs all six sections") ?? false }));
    const jobs = await db.query("SELECT kind,status,attempts,created_at FROM demo_jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 8", [tenant.id]);
    console.log(JSON.stringify({ recentJobStates: jobs }));
    const settingsResponse = await runtime.request(current, "/v1/config");
    const settings = settingsResponse.ok ? await settingsResponse.json() as { llm?: { activeProfile?: string; defaultProvider?: string; profiles?: Record<string, { provider?: string; model?: string; effort?: string }>; callSites?: Record<string, { profile?: string; effort?: string }> } } : {};
    const llm = settings.llm;
    const profile = llm?.activeProfile ?? llm?.callSites?.mainAgent?.profile;
    const selected = profile ? llm?.profiles?.[profile] : undefined;
    const safeLabel = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) ? value : undefined;
    console.log(JSON.stringify({ configuredInference: { status: settingsResponse.status, profile: safeLabel(profile), defaultProvider: safeLabel(llm?.defaultProvider), provider: safeLabel(selected?.provider), model: safeLabel(selected?.model), effort: safeLabel(llm?.callSites?.mainAgent?.effort ?? selected?.effort) } }));
    const checklistResponse = await runtime.request(current, "/v1/heartbeat/checklist");
    const checklist = checklistResponse.ok ? await checklistResponse.json() as { content?: string } : {};
    console.log(JSON.stringify({ heartbeatChecklistStatus: checklistResponse.status, hasFreshConnectionGuidance: checklist.content?.includes("A successful read supersedes an earlier expiration") ?? false }));
    for (const path of ["/healthz", "/v1/health"]) {
      const response = await runtime.request(current, path);
      console.log(JSON.stringify({ runtimeHealthPath: path, status: response.status }));
    }
    const skill = await runtime.request(current, "/v1/skills/hosted-outlook-connect-v1/files/content?path=SKILL.md");
    const skillBody = skill.ok ? await skill.json() as { content?: string } : {};
    console.log(JSON.stringify({ hostedSkillStatus: skill.status, includesImmediateLinkDescription: skillBody.content?.includes("not an offer to send one") ?? false }));
    const [ticket] = await db.query<{ payload: string }>("SELECT payload FROM demo_tickets WHERE hash=$1", [ticketHash]);
    const context = ticket ? store.vault.open<{ conversationId?: string }>(ticket.payload, ticketHash) : {};
    if (context.conversationId) {
      const transcript = await runtime.request(current, `/v1/messages?conversationId=${encodeURIComponent(context.conversationId)}&limit=100&page=latest`);
      const result = transcript.ok ? await transcript.json() as { messages?: Array<{ role?: string; timestamp?: string; contentBlocks?: unknown; toolCalls?: unknown }> } : {};
      const outlookCalls = result.messages?.flatMap((message) => {
        const blocks = Array.isArray(message.contentBlocks) ? message.contentBlocks : [];
        const calls = blocks.filter((block) => block?.type === "tool_use").map((block) => block.toolCall);
        return calls.filter((call) => call && JSON.stringify(call.input).includes("outlook")).map((call) => {
          const input = JSON.stringify(call.input);
          const output = typeof call.result === "string" ? call.result : "";
          return {
            timestamp: message.timestamp,
            toolName: typeof call.name === "string" && /^[a-zA-Z0-9_.:-]+$/.test(call.name) ? call.name : "unknown",
            hasResult: Boolean(output), isError: call.isError === true,
            inboxRequest: /mailFolders.*inbox/i.test(input),
            calendarRequest: /calendarView|\/events/.test(input),
            provider200InResult: /["']?status["']?\s*:\s*200/.test(output),
          };
        });
      });
      console.log(JSON.stringify({ outlookToolTrace: outlookCalls }));
      console.log(JSON.stringify({ transcriptStatus: transcript.status, recentTurnEvidence: result.messages?.slice(-10).map((message) => {
        const content = JSON.stringify([message.contentBlocks, message.toolCalls]);
        return { role: message.role, timestamp: message.timestamp, hostedSkill: content.includes("hosted-outlook-connect-v1"), oauthStatus: content.includes("oauth status"), connectionRequest: content.includes("integrations/connect"), toolUse: Array.isArray(message.toolCalls) && message.toolCalls.length > 0 };
      }) }));
    }
  }
}
process.exit(0);
