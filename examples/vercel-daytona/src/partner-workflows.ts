import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderHostedSkill, type HostedSkill } from "./hosted-skills.js";
import type { Runtime } from "./runtime.js";
import type { Tenant } from "./store.js";

export const partnerSkillId = "hosted-partner-workflows-v1";
const assetRoot = new URL("../partner-workflows/", import.meta.url);
const assetPaths = [
  "references/evidence.md", "references/pre-call.md", "references/needs-you.md",
  "references/delegation.md", "references/precedent.md", "references/time-entries.md",
  "scripts/time-entries.ts",
] as const;

function readAsset(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, assetRoot)), "utf8");
}

const entrypoint = readAsset("SKILL.md").replace(/^---\n[\s\S]*?\n---\n/, "");
export const partnerSkill: HostedSkill = {
  skillId: partnerSkillId,
  name: "Partner workflows",
  description: "For a client call, prepare a pre-call brief. For what needs me, show partner decisions across matters. Draft associate delegations with context, recall internal deal precedents, and reconstruct time entries from activity. Use current matter evidence and concise Telegram replies.",
  bodyMarkdown: entrypoint,
};

const assets = [
  { path: "SKILL.md", content: renderHostedSkill(partnerSkill) },
  ...assetPaths.map((path) => ({ path, content: readAsset(path) })),
];
const fingerprint = createHash("sha256").update(JSON.stringify({ partnerSkill, assets })).digest("hex");
const manifestPath = "installation.json";

type Request = (path: string, options?: RequestInit) => Promise<Response>;
function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function checked(request: Request, path: string, options?: RequestInit): Promise<Response> {
  const response = await request(path, options);
  if (!response.ok) {
    throw new Error(`Partner workflow setup failed (${response.status})`);
  }
  return response;
}

async function writeFile(request: Request, path: string, content: string): Promise<void> {
  await checked(request, "/v1/workspace/write", json("POST", { path: `skills/${partnerSkillId}/${path}`, content }));
  const response = await checked(request, `/v1/skills/${partnerSkillId}/files/content?path=${encodeURIComponent(path)}`);
  const file = await response.json() as { content?: string };
  if (file.content !== content) {
    throw new Error("Partner workflow file verification failed");
  }
}

const heartbeatStart = "<!-- hosted-partner-workflows:v1:start -->";
const heartbeatEnd = "<!-- hosted-partner-workflows:v1:end -->";
const heartbeatGuidance = `${heartbeatStart}
## Partner workflow review

Load skills/${partnerSkillId}/SKILL.md for partner work. Its workflow-specific
formats apply to pre-call briefs, needs-you feeds, delegations, precedent recall
and time reconstruction. Retain legal-review attribution, uncertainty and send
boundaries; do not append a second six-section packet to these compact outputs.

Use the existing morning review slot for the needs-you feed across authorized
matters. Surface only decisions requiring the partner, with sources and why today.
Do not send a duplicate general digest. Suppress routine progress and unchanged
items. This workflow stays quiet when nothing actionable changed; a failed source
read is not an all-clear. Preserve explicit user preferences and existing times.

Reconcile existing event wakes for client calls and prepare one source-backed
brief 15 minutes before each eligible call. Read the live calendar before sending,
handle cancellations and rescheduling, and reuse matching wakes. Do not claim
15-minute coverage from an hourly heartbeat if event wakes are unavailable.

When time reconstruction is requested, use the evening review and shared matter
evidence to propose entries for approval. Do not submit billing or contact an
associate without the partner's instruction. Use the existing private-channel
delivery and proactive-check record, recording only confirmed deliveries.
${heartbeatEnd}`;

export async function integratePartnerHeartbeat(request: Request): Promise<boolean> {
  const read = async () => {
    const response = await checked(request, "/v1/heartbeat/checklist");
    const result = await response.json() as { content?: string };
    if (typeof result.content !== "string") {
      throw new Error("Partner heartbeat checklist unavailable");
    }
    return result.content;
  };
  const previous = await read();
  // An empty checklist does not authorize enabling proactive work.
  if (!previous.trim()) { return false; }
  const start = previous.indexOf(heartbeatStart);
  const end = previous.indexOf(heartbeatEnd);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
    throw new Error("Partner heartbeat markers are incomplete; checklist preserved");
  }
  const content = start < 0
    ? `${previous.trimEnd()}\n\n${heartbeatGuidance}\n`
    : `${previous.substring(0, start)}${heartbeatGuidance}${previous.substring(end + heartbeatEnd.length)}`;
  if (content === previous) { return false; }
  await checked(request, "/v1/workspace/write", json("POST", {
    path: `proactive-checks/heartbeat-before-partner-workflows-${randomUUID()}.md`, content: previous,
  }));
  if (await read() !== previous) {
    throw new Error("Heartbeat changed during preparation; checklist preserved");
  }
  await checked(request, "/v1/heartbeat/checklist", json("PUT", { content }));
  if (await read() !== content) {
    throw new Error("Partner heartbeat verification failed; inspect the preserved backup");
  }
  return true;
}

export async function installPartnerWorkflows(tenant: Tenant, runtime: Runtime): Promise<void> {
  const request: Request = (path, options) => runtime.request(tenant, path, options);
  const lookup = await request(`/v1/skills/${partnerSkillId}`);
  if (lookup.status === 404) {
    await checked(request, "/v1/skills", json("POST", partnerSkill));
  } else if (!lookup.ok) {
    throw new Error("Partner workflow lookup failed");
  }
  const rootResponse = await request(`/v1/skills/${partnerSkillId}/files/content?path=SKILL.md`);
  if (!rootResponse.ok && rootResponse.status !== 404) {
    throw new Error("Partner workflow entrypoint unavailable");
  }
  const root = rootResponse.ok ? await rootResponse.json() as { content?: string } : {};
  const rootChanged = root.content !== assets[0]!.content;
  const existing = await request(`/v1/skills/${partnerSkillId}/files/content?path=${manifestPath}`);
  let installedFingerprint: unknown;
  if (existing.ok) {
    const file = await existing.json() as { content?: string };
    try { installedFingerprint = JSON.parse(file.content ?? "{}").fingerprint; } catch { installedFingerprint = undefined; }
  } else if (existing.status !== 404) {
    throw new Error("Partner workflow installation state unavailable");
  }
  if (rootChanged || installedFingerprint !== fingerprint) {
    await writeFile(request, manifestPath, JSON.stringify({ version: 1, status: "installing" }));
    for (const asset of assets) {
      await writeFile(request, asset.path, asset.content);
    }
    for (const path of ["/v1/memory/v2/reembed-skills", "/v1/memory/v3/rebuild-index"]) {
      await checked(request, path, json("POST", {}));
    }
    await writeFile(request, manifestPath, JSON.stringify({ version: 1, fingerprint }));
  }
  await integratePartnerHeartbeat(request);
}
