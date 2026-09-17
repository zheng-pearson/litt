import { partnerSkillId } from "../src/partner-workflows.js";
import type { Runtime } from "../src/runtime.js";

export function partnerHarness() {
  const tenants = new Map<string, { installed: boolean; files: Map<string, string>; heartbeat: string }>();
  const calls: { tenant: string; path: string; method: string }[] = [];
  let failPath: string | undefined;
  function state(id: string) {
    let data = tenants.get(id);
    if (!data) {
      data = { installed: false, files: new Map(), heartbeat: "Existing morning time, quiet hours and connection guidance.\n" };
      tenants.set(id, data);
    }
    return data;
  }
  const runtime: Runtime = {
    async provision() {},
    async request(tenant, path, options) {
      const data = state(tenant.id);
      const method = options?.method ?? "GET";
      calls.push({ tenant: tenant.id, path, method });
      if (path === failPath) { return new Response("Unavailable", { status: 503 }); }
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      const url = new URL(path, "https://assistant.example.com");
      if (path === `/v1/skills/${partnerSkillId}`) {
        return data.installed ? Response.json({ skillId: partnerSkillId }) : new Response(null, { status: 404 });
      }
      if (path === "/v1/skills" && method === "POST") {
        data.installed = true;
        return Response.json({ ok: true });
      }
      if (url.pathname === `/v1/skills/${partnerSkillId}/files/content`) {
        const content = data.files.get(`skills/${partnerSkillId}/${url.searchParams.get("path")}`);
        return content === undefined ? new Response(null, { status: 404 }) : Response.json({ content });
      }
      if (path === "/v1/workspace/write") {
        data.files.set(body.path, body.content);
        return Response.json({ ok: true });
      }
      if (path === "/v1/heartbeat/checklist") {
        if (method === "PUT") { data.heartbeat = body.content; }
        return Response.json({ content: data.heartbeat });
      }
      if (path.startsWith("/v1/memory/")) { return Response.json({ ok: true }); }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
  return { runtime, state, calls, fail: (path?: string) => { failPath = path; } };
}
