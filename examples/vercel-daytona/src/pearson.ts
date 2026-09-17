import { z } from "zod";
import type { Config } from "./config.js";
import type { Runtime } from "./runtime.js";
import type { Tenant } from "./store.js";
import { HttpError } from "./security.js";

export const PEARSON_SERVER = "pearson";
export async function startPearsonConnection(config: Config, tenant: Tenant, runtime: Runtime) {
  if (!config.PEARSON_MCP_URL) { throw new HttpError(503, "Pearson connection is not configured"); }
  const list = await runtime.request(tenant, "/v1/internal/mcp/list");
  if (!list.ok) { throw new Error("Could not inspect Pearson connection"); }
  const schema = z.array(z.object({ id: z.string(), transport: z.object({ type: z.string(), url: z.string().optional() }), hasStaticAuth: z.boolean().optional() }));
  const servers = z.object({ servers: schema }).parse(await list.json()).servers;
  const server = servers.find(entry => entry.id === PEARSON_SERVER);
  if (server && (server.transport.url !== config.PEARSON_MCP_URL || server.transport.type !== "streamable-http" || server.hasStaticAuth)) {
    throw new HttpError(409, "An incompatible Pearson connection already exists. Contact support.");
  }
  if (!server) {
    const added = await runtime.request(tenant, "/v1/internal/mcp/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: PEARSON_SERVER, transportType: "streamable-http", url: config.PEARSON_MCP_URL }),
    });
    if (!added.ok) { throw new Error("Pearson connection registration failed"); }
  }
  const response = await runtime.request(tenant, "/v1/internal/mcp/auth/start", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverId: PEARSON_SERVER }),
  });
  if (!response.ok) { throw new Error("Pearson sign-in could not start"); }
  const flow = z.object({ auth_url: z.string(), already_authenticated: z.boolean().optional() }).parse(await response.json());
  if (flow.already_authenticated) { return { alreadyAuthenticated: true as const }; }
  const auth = new URL(flow.auth_url);
  const resource = new URL(config.PEARSON_MCP_URL);
  if (auth.origin !== resource.origin || auth.pathname !== "/second/authorize" || auth.searchParams.get("redirect_uri") !== `${config.PUBLIC_BASE_URL}/webhooks/oauth/callback` || auth.searchParams.get("resource") !== config.PEARSON_MCP_URL || auth.searchParams.get("code_challenge_method") !== "S256") {
    throw new Error("Unexpected Pearson authorization destination");
  }
  const state = auth.searchParams.get("state");
  if (!state || state.length < 16) { throw new Error("Missing Pearson authorization state"); }
  return { alreadyAuthenticated: false as const, authUrl: auth.href, state };
}

export async function verifyPearsonCallback(tenant: Tenant, runtime: Runtime): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await runtime.request(tenant, `/v1/internal/mcp/auth/status/${PEARSON_SERVER}`);
    if (!response.ok) { throw new Error("Pearson sign-in could not be verified"); }
    const result = z.object({ status: z.enum(["pending", "complete", "error"]) }).parse(await response.json());
    if (result.status === "complete") { return true; }
    if (result.status === "error") { return false; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Pearson sign-in is still completing. Retry this page shortly.");
}
