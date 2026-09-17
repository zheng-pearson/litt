import { Daytona } from "@daytona/sdk";
import { readConfig } from "../src/config.js";
import { legalReviewSkill, writeHostedSkill } from "../src/hosted-skills.js";
import { DaytonaRuntime } from "../src/runtime.js";
import { Vault } from "../src/security.js";
import { database, Store } from "../src/store.js";

if (process.env.VERCEL_ENV !== "production" || !/^[a-f0-9-]{36}$/.test(process.env.RUNTIME_TENANT_ID ?? "")) {
  throw new Error("A production runtime target is required");
}
const config = readConfig();
const store = new Store(database(config.DATABASE_URL), new Vault(config.ENCRYPTION_KEY));
const tenant = await store.tenant(process.env.RUNTIME_TENANT_ID!);
if (tenant.id !== process.env.RUNTIME_TENANT_ID || tenant.status !== "active" || !tenant.sandbox_id) {
  throw new Error("Legal guidance target is not an active canonical tenant");
}
const runtime = new DaytonaRuntime(config, store, new Daytona({ apiKey: config.DAYTONA_API_KEY, target: config.DAYTONA_TARGET }));
await writeHostedSkill(tenant, runtime, legalReviewSkill);
for (const path of ["/v1/memory/v2/reembed-skills", "/v1/memory/v3/rebuild-index"]) {
  const response = await runtime.request(tenant, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (!response.ok) { throw new Error("Legal skill discovery refresh failed"); }
}
const response = await runtime.request(tenant, `/v1/skills/${legalReviewSkill.skillId}/files/content?path=SKILL.md`);
const file = response.ok ? await response.json() as { content?: string } : {};
if (!file.content?.endsWith(legalReviewSkill.bodyMarkdown)) {
  throw new Error("Legal guidance readback failed");
}
console.log(JSON.stringify({ legalGuidanceVerified: true, skillId: legalReviewSkill.skillId }));
process.exit(0);
