import { readFile } from "node:fs/promises";
import { Daytona } from "@daytona/sdk";
import { readConfig } from "../src/config.js";
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
  throw new Error("Runtime upgrade target is not an active canonical tenant");
}
const client = new Daytona({ apiKey: config.DAYTONA_API_KEY, target: config.DAYTONA_TARGET });
const sandbox = await client.get(tenant.sandbox_id);
const upgrades: Record<string, { file: string; paths: string[] }> = {
  "oauth-recovery-v1": { file: "runtime-oauth-recovery.patch", paths: ["assistant/src/runtime/routes/oauth-commands-routes.ts"] },
  "telegram-freshness-v1": { file: "runtime-telegram-freshness.patch", paths: ["assistant/src/messaging/providers/retry-policy.ts", "assistant/src/messaging/providers/telegram-bot/api.ts", "assistant/src/messaging/providers/telegram-bot/send.ts", "assistant/src/notifications/types.ts", "assistant/src/notifications/broadcaster.ts", "assistant/src/notifications/adapters/telegram.ts"] },
  "telegram-fallback-v1": { file: "runtime-telegram-fallback.patch", paths: ["assistant/src/notifications/adapters/telegram.ts", "assistant/src/messaging/providers/telegram-bot/send.ts"] },
  "credential-health-v1": { file: "runtime-health.patch", paths: ["assistant/src/credential-health/credential-health-service.ts", "assistant/src/heartbeat/heartbeat-service.ts", "assistant/src/notifications/emit-signal.ts"] },
  "notification-freshness-v1": { file: "runtime-notification.patch", paths: ["assistant/src/notifications/broadcaster.ts", "assistant/src/notifications/emit-signal.ts"] },
  "credential-health-retry-v1": { file: "runtime-health-retry.patch", paths: ["assistant/src/credential-health/credential-health-service.ts"] },
};
const patchKind = process.env.RUNTIME_PATCH_KIND ?? "credential-health-v1";
if (!Object.hasOwn(upgrades, patchKind)) { throw new Error("Unknown runtime patch kind"); }
const upgrade = upgrades[patchKind]!;
const sourcePaths = upgrade.paths;
const backupPath = `/opt/vellum/.hosted-upgrades/${patchKind}`;
const patch = await readFile(new URL(`./${upgrade.file}`, import.meta.url), "utf8");
const command = `bun -e 'const patch=Buffer.from(process.env.RUNTIME_HEALTH_PATCH,"base64"); const child=Bun.spawn(["git","apply","--check","-"],{stdin:"pipe",stdout:"ignore",stderr:"pipe",windowsHide:true}); child.stdin.write(patch); child.stdin.end(); const errors=await new Response(child.stderr).text(); console.log(errors); process.exit(await child.exited);'`;
const preflight = await sandbox.process.executeCommand(command, "/opt/vellum", {
  RUNTIME_HEALTH_PATCH: Buffer.from(patch).toString("base64"),
}, 20);
if (preflight.exitCode !== 0) {
  console.log(preflight.result);
  throw new Error("Runtime patch preflight failed; no files changed");
}
console.log("Runtime health patch preflight passed; no files changed");
if (process.env.APPLY_RUNTIME_HEALTH !== "true") { process.exit(0); }

// The lifecycle command drains in-flight work and refuses unsafe active calls.
const stopped = await sandbox.process.executeCommand(
  "bun cli/src/index.ts sleep hosted-demo --wait 30s", "/opt/vellum", { VELLUM_ENVIRONMENT: "local" }, 90,
);
if (stopped.exitCode !== 0) { throw new Error("Runtime drain did not complete; no files changed"); }
const applyCommand = `bun -e 'import {mkdirSync,copyFileSync,existsSync,readFileSync} from "node:fs";
const paths=${JSON.stringify(sourcePaths)};
const backup=${JSON.stringify(backupPath)};
if(existsSync(backup)) {
  for(let i=0;i<paths.length;i++){if(!readFileSync(paths[i]).equals(readFileSync(backup+"/"+i))) throw new Error("Source differs from preserved backup");}
} else {
  mkdirSync(backup,{recursive:true});
  for(let i=0;i<paths.length;i++){copyFileSync(paths[i],backup+"/"+i);}
}
try {
  const child=Bun.spawn(["git","apply","-"],{stdin:"pipe",stdout:"ignore",stderr:"ignore",windowsHide:true});
  child.stdin.write(Buffer.from(process.env.RUNTIME_HEALTH_PATCH,"base64"));
  child.stdin.end();
  if(await child.exited!==0) throw new Error("Patch failed");
  const compiled=await Bun.build({entrypoints:paths,target:"bun",packages:"external",external:["*"]});
  if(!compiled.success) throw new Error("Runtime syntax check failed");
} catch(error) {for(let i=0;i<paths.length;i++){copyFileSync(backup+"/"+i,paths[i]);}throw error;}
'`;
const applied = await sandbox.process.executeCommand(applyCommand, "/opt/vellum", {
  RUNTIME_HEALTH_PATCH: Buffer.from(patch).toString("base64"),
}, 30);
// The shared lifecycle path wakes the same assistant and updates its token.
const runtime = new DaytonaRuntime(config, store, client);
try {
  await runtime.wakeExisting(tenant);
  let healthy = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const health = await runtime.request(tenant, "/v1/health");
    console.log(JSON.stringify({ runtimeHealthStatus: health.status, attempt }));
    if (health.ok) { healthy = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!healthy) { throw new Error("Runtime health check failed"); }
} catch {
  const rollback = await sandbox.process.executeCommand(`bun -e 'import {copyFileSync} from "node:fs";const paths=${JSON.stringify(sourcePaths)};for(let i=0;i<paths.length;i++){copyFileSync(${JSON.stringify(backupPath + "/")}+i,paths[i]);}'`, "/opt/vellum", {}, 20);
  if (rollback.exitCode !== 0) { throw new Error("Runtime recovery failed; inspect preserved source backups"); }
  await sandbox.process.executeCommand("bun cli/src/index.ts sleep hosted-demo --wait 30s", "/opt/vellum", { VELLUM_ENVIRONMENT: "local" }, 90);
  await runtime.wakeExisting(tenant);
  throw new Error("Runtime health check failed; previous sources restored and restart requested");
}
if (applied.exitCode !== 0) { throw new Error("Runtime patch was not applied; assistant restarted with previous sources"); }
console.log("Runtime health patch applied and assistant restarted with a healthy gateway");
process.exit(0);
