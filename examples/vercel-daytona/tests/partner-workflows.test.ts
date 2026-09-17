import { describe, expect, test } from "bun:test";
import { installPartnerWorkflows, integratePartnerHeartbeat, partnerSkillId } from "../src/partner-workflows.js";
import { partnerHarness as harness } from "./partner-workflows-fixture.js";
import type { Tenant } from "../src/store.js";


const tenant = { id: "tenant-123" } as Tenant;

describe("hosted partner workflow installation", () => {
  test("installs all five workflows, executable duration helper and discovery indexes", async () => {
    const h = harness();
    await installPartnerWorkflows(tenant, h.runtime);
    const files = h.state(tenant.id).files;
    for (const name of ["pre-call", "needs-you", "delegation", "precedent", "time-entries"]) {
      expect(files.has(`skills/${partnerSkillId}/references/${name}.md`)).toBe(true);
    }
    expect(files.has(`skills/${partnerSkillId}/scripts/time-entries.ts`)).toBe(true);
    expect(files.get(`skills/${partnerSkillId}/SKILL.md`)).toContain("always-candidate: true");
    expect(h.calls.some((call) => call.path === "/v1/memory/v3/rebuild-index")).toBe(true);
    expect(h.state(tenant.id).heartbeat).toStartWith("Existing morning time, quiet hours and connection guidance.");
    expect(h.state(tenant.id).heartbeat).toContain("15 minutes");
  });

  test("second installation is read-only and preserves unrelated user files", async () => {
    const h = harness();
    h.state(tenant.id).files.set("notes/user.md", "Keep this");
    await installPartnerWorkflows(tenant, h.runtime);
    h.calls.length = 0;
    await installPartnerWorkflows(tenant, h.runtime);
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
    expect(h.state(tenant.id).files.get("notes/user.md")).toBe("Keep this");
  });

  test("failed discovery leaves an incomplete manifest and retries discovery", async () => {
    const h = harness();
    h.fail("/v1/memory/v3/rebuild-index");
    await expect(installPartnerWorkflows(tenant, h.runtime)).rejects.toThrow("503");
    const key = `skills/${partnerSkillId}/installation.json`;
    expect(JSON.parse(h.state(tenant.id).files.get(key)!).status).toBe("installing");
    h.fail();
    await installPartnerWorkflows(tenant, h.runtime);
    expect(JSON.parse(h.state(tenant.id).files.get(key)!).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("partial upload cannot report installation success", async () => {
    const h = harness();
    h.fail(`/v1/skills/${partnerSkillId}/files/content?path=references%2Fdelegation.md`);
    await expect(installPartnerWorkflows(tenant, h.runtime)).rejects.toThrow("503");
    expect(h.calls.some((call) => call.path === "/v1/memory/v3/rebuild-index")).toBe(false);
    h.fail();
    await installPartnerWorkflows(tenant, h.runtime);
  });

  test("repairing the entrypoint invalidates a previously successful manifest", async () => {
    const h = harness();
    await installPartnerWorkflows(tenant, h.runtime);
    h.state(tenant.id).files.set(`skills/${partnerSkillId}/SKILL.md`, "Incomplete file");
    h.fail("/v1/memory/v2/reembed-skills");
    await expect(installPartnerWorkflows(tenant, h.runtime)).rejects.toThrow();
    h.fail();
    h.calls.length = 0;
    await installPartnerWorkflows(tenant, h.runtime);
    expect(h.calls.some((call) => call.path === "/v1/memory/v2/reembed-skills")).toBe(true);
  });

  test("keeps tenant writes separate", async () => {
    const h = harness();
    await installPartnerWorkflows(tenant, h.runtime);
    expect(h.calls.every((call) => call.tenant === tenant.id)).toBe(true);
    expect(h.state("tenant-456").installed).toBe(false);
  });

  test("does not start proactive work for an empty checklist", async () => {
    const h = harness();
    h.state(tenant.id).heartbeat = "";
    await installPartnerWorkflows(tenant, h.runtime);
    expect(h.state(tenant.id).heartbeat).toBe("");
    expect(h.calls.some((call) => call.path === "/v1/heartbeat/checklist" && call.method === "PUT")).toBe(false);
  });
});

test("heartbeat refuses to overwrite a concurrent edit", async () => {
  let reads = 0;
  let puts = 0;
  await expect(integratePartnerHeartbeat(async (_path, options) => {
    if (options?.method === "PUT") { puts++; }
    if (!options?.method) { reads++; }
    return Response.json({ content: reads > 1 ? "User correction" : "Original review" });
  })).rejects.toThrow("changed during preparation");
  expect(puts).toBe(0);
});

test("heartbeat repairs only its own managed section", async () => {
  const h = harness();
  await installPartnerWorkflows(tenant, h.runtime);
  h.state(tenant.id).heartbeat = `${h.state(tenant.id).heartbeat.replace("15 minutes", "20 minutes")}\nUser instruction: preserve this.\n`;
  await installPartnerWorkflows(tenant, h.runtime);
  expect(h.state(tenant.id).heartbeat).toContain("15 minutes");
  expect(h.state(tenant.id).heartbeat).toEndWith("User instruction: preserve this.\n");
});
