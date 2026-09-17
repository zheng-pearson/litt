import { Daytona } from "@daytona/sdk";
import { readConfig } from "../src/config.js";
import { DaytonaRuntime } from "../src/runtime.js";
import { Vault } from "../src/security.js";
import { database, Store } from "../src/store.js";

const marker = "## Hosted connection evidence v1";
const guidance = `${marker}

Before reporting an email or calendar access failure, load the current
skills/hosted-outlook-connect-v1/SKILL.md and follow its shared status, ping and
service-read procedure. A successful read supersedes an earlier expiration.
Previous check records are historical, not authoritative connection state.
An access-token expiry timestamp alone is not lost consent: use the shared
request path so refresh and retry can run. Preserve the distinction between
consent failure, insufficient service access and temporary unavailability.
For a proven consent failure requiring user action, include the fresh secure
link from that skill in the same alert and explain what resumes after consent.
Do not repeat an unchanged access alert. Recheck evidence immediately before
sending through the notifications skill, and record only confirmed delivery.
`;

export async function updateHeartbeatGuidance(request: (path: string, method?: string, body?: unknown) => Promise<{ content?: string }>): Promise<boolean> {
  const previous = (await request("/v1/heartbeat/checklist")).content;
  if (typeof previous !== "string") { throw new Error("Heartbeat checklist unavailable"); }
  if (previous.includes(marker)) { return false; }
  await request("/v1/workspace/write", "POST", {
    path: `proactive-checks/heartbeat-before-connection-evidence-v1-${crypto.randomUUID()}.md`, content: previous,
  });
  const current = (await request("/v1/heartbeat/checklist")).content;
  if (current !== previous) { throw new Error("Heartbeat checklist changed during preparation; not overwritten"); }
  const content = `${previous.trimEnd()}\n\n${guidance}`;
  await request("/v1/heartbeat/checklist", "PUT", { content });
  if ((await request("/v1/heartbeat/checklist")).content !== content) {
    throw new Error("Heartbeat guidance write could not be verified; inspect preserved backup");
  }
  return true;
}

export async function applyHeartbeatGuidance(): Promise<void> {
  if (process.env.VERCEL_ENV !== "production" || !/^[a-f0-9-]{36}$/.test(process.env.RUNTIME_TENANT_ID ?? "")) {
    throw new Error("A production runtime target is required");
  }
  const config = readConfig();
  const store = new Store(database(config.DATABASE_URL), new Vault(config.ENCRYPTION_KEY));
  const tenant = await store.tenant(process.env.RUNTIME_TENANT_ID!);
  if (tenant.id !== process.env.RUNTIME_TENANT_ID || tenant.status !== "active" || !tenant.sandbox_id) {
    throw new Error("Heartbeat target is not an active canonical tenant");
  }
  const runtime = new DaytonaRuntime(config, store, new Daytona({ apiKey: config.DAYTONA_API_KEY, target: config.DAYTONA_TARGET }));
  const changed = await updateHeartbeatGuidance(async (path, method = "GET", body) => {
    const response = await runtime.request(tenant, path, {
      method, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) { throw new Error(`Heartbeat maintenance request failed (${response.status})`); }
    return response.json();
  });
  console.log(JSON.stringify({ heartbeatGuidanceVerified: true, changed }));
  process.exit(0);
}
