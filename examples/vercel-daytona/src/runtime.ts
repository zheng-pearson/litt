import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { z } from "zod";
import type { Config } from "./config.js";
import { digest, randomToken } from "./security.js";
import type { Store, Tenant } from "./store.js";
import { installConnectionSkill } from "./connections.js";

export interface Runtime {
  provision(tenant: Tenant): Promise<void>;
  configureTelegram?(tenant: Tenant): Promise<void>;
  request(
    tenant: Tenant,
    path: string,
    options?: RequestInit,
  ): Promise<Response>;
}

const secretsSchema = z.object({
  webhookSecret: z.string().min(32),
  guardianToken: z.string().min(20),
  port: z.number().int().min(1).max(65535),
  telegramTokenDigest: z.string().optional(),
});
type Secrets = z.infer<typeof secretsSchema>;

const hostedIntro = {
  lengthOld: '**UNBREAKABLE ABSOLUTE RULE FOR MESSAGING:** In messaging channels (Slack, Telegram, SMS, email), your responses MUST NEVER EXCEED 2 sentences.\n\n**UNBREAKABLE ABSOLUTE RULE FOR RESPONSE LENGTH:** Your responses to users MUST NEVER EXCEED 3 sentences. One sentence is the default. Two is the max for most situations. Three only when the user explicitly needs detail. If the user sends a short message, respond in kind. Brevity is not optional.',
  lengthNew: "**Response length:** Be concise by default, especially in messaging channels. Match casual messages with short replies. For substantive work, use the space and structure needed to complete the user's request; brevity must not omit required facts, options, approvals, or action status.",
  soulOld:
    'You: "bunch of stuff. web research, coding, building tools, messaging, scheduling. or I can just be your friend. what do you need?"',
  soulNew:
    "You: \"as your second in command, i handle the stuff that eats your time: email and calendar (scheduling, chasing replies, drafting), bookings like flights, restaurants, rides, and deliveries, research and comparisons, loose ends, and watching for things you're waiting on so i can tell you the moment they land. what's taking up your time right now?\"",
  bootstrapOld:
    "- Don't list your capabilities. Ask what they're trying to do and take it from there.",
  bootstrapNew:
    "- Position yourself as their second in command. Focus on the time-consuming work you can take off their plate, then ask what is taking up their time right now.",
};

const hostedIntroCommand = `bun -e 'import { existsSync, readFileSync, writeFileSync } from "node:fs";
const { findAssistantByName } = await import("./cli/src/lib/assistant-config.ts");
const entry = findAssistantByName("hosted-demo");
if (!entry?.resources?.instanceDir) throw new Error("Hosted assistant unavailable");
const workspace = entry.resources.instanceDir + "/.vellum/workspace";
for (const [path, before, after] of [
  ["/opt/vellum/assistant/src/prompts/templates/SOUL.md", process.env.INTRO_SOUL_OLD, process.env.INTRO_SOUL_NEW],
  ["/opt/vellum/assistant/src/prompts/templates/BOOTSTRAP.md", process.env.INTRO_BOOTSTRAP_OLD, process.env.INTRO_BOOTSTRAP_NEW],
  [workspace + "/SOUL.md", process.env.INTRO_SOUL_OLD, process.env.INTRO_SOUL_NEW],
  [workspace + "/BOOTSTRAP.md", process.env.INTRO_BOOTSTRAP_OLD, process.env.INTRO_BOOTSTRAP_NEW],
  ["/opt/vellum/assistant/src/prompts/templates/SOUL.md", process.env.INTRO_LENGTH_OLD, process.env.INTRO_LENGTH_NEW],
  [workspace + "/SOUL.md", process.env.INTRO_LENGTH_OLD, process.env.INTRO_LENGTH_NEW],
]) {
  if (!existsSync(path) || !before || !after) continue;
  const current = readFileSync(path, "utf8");
  if (current.includes(before)) writeFileSync(path, current.replace(before, after));
}'`;

export class DaytonaRuntime implements Runtime {
  private connectionSkills = new Map<string, Promise<void>>();
  private interactivePolicies = new Map<string, Promise<void>>();
  private introSetups = new Map<string, Promise<void>>();
  private daytona: Pick<Daytona, "get" | "create">;
  constructor(
    private config: Config,
    private store: Store,
    client?: Pick<Daytona, "get" | "create">,
    private fetcher: (
      url: string | URL | Request,
      options?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {
    this.daytona =
      client ??
      new Daytona({
        apiKey: config.DAYTONA_API_KEY,
        target: config.DAYTONA_TARGET,
      });
  }
  private async wake(sandbox: Sandbox, tenant: Tenant): Promise<void> {
    const result = await sandbox.process.executeCommand(
      "bun /opt/vellum-demo/bootstrap.ts --wake",
      "/opt/vellum",
      { VELLUM_ENVIRONMENT: "local" },
      120,
    );
    if (result.exitCode !== 0) {
      throw new Error("Assistant restart failed");
    }
    const line = result.result
      .split("\n")
      .find((v) => v.startsWith("DEMO_TOKEN="));
    const parsed = z
      .object({ guardianToken: z.string().min(20) })
      .parse(JSON.parse(line?.slice(11) ?? "null"));
    if (!tenant.secrets) {
      throw new Error("Assistant credentials unavailable");
    }
    const secret = this.store.vault.open<Secrets>(tenant.secrets, tenant.id);
    secret.guardianToken = parsed.guardianToken;
    tenant.secrets = this.store.vault.seal(secret, tenant.id);
    await this.store.db.query(
      "UPDATE demo_tenants SET secrets=$2 WHERE id=$1",
      [tenant.id, tenant.secrets],
    );
  }
  async wakeExisting(tenant: Tenant): Promise<void> {
    await this.wake(await this.sandbox(tenant), tenant);
  }
  private async applyHostedIntro(sandbox: Sandbox): Promise<void> {
    const result = await sandbox.process.executeCommand(
      hostedIntroCommand,
      "/opt/vellum",
      {
        VELLUM_ENVIRONMENT: "local",
        INTRO_SOUL_OLD: hostedIntro.soulOld,
        INTRO_SOUL_NEW: hostedIntro.soulNew,
        INTRO_BOOTSTRAP_OLD: hostedIntro.bootstrapOld,
        INTRO_BOOTSTRAP_NEW: hostedIntro.bootstrapNew,
        INTRO_LENGTH_OLD: hostedIntro.lengthOld,
        INTRO_LENGTH_NEW: hostedIntro.lengthNew,
      },
      30,
    );
    if (result.exitCode !== 0) {
      throw new Error("Hosted intro setup failed");
    }
  }
  private async sandbox(tenant: Tenant, create = false) {
    const name = `vellum-demo-${tenant.id}`;
    let sandbox;
    try {
      sandbox = await this.daytona.get(tenant.sandbox_id ?? name);
    } catch (error) {
      if (
        !(error instanceof DaytonaNotFoundError) ||
        !create ||
        tenant.sandbox_id
      ) {
        throw error;
      }
      sandbox = await this.daytona.create(
        {
          name,
          snapshot: this.config.DAYTONA_SNAPSHOT,
          public: false,
          autoStopInterval: 0,
          autoPauseInterval: 0,
          autoDeleteInterval: -1,
          labels: { application: "vellum-demo", tenant: tenant.id },
        },
        { timeout: 70 },
      );
    }
    if (sandbox.state !== "started") {
      await sandbox.start(70);
      if (tenant.status === "active") {
        await this.wake(sandbox, tenant);
      }
    }
    return sandbox;
  }
  async configureTelegram(tenant: Tenant): Promise<void> {
    if (!this.config.TELEGRAM_UPDATE_BOT_ID || !tenant.secrets) {
      throw new Error("Telegram cutover requires a namespaced bot and a provisioned assistant");
    }
    const fingerprint = digest(this.config.TELEGRAM_BOT_TOKEN);
    const previous = this.store.vault.open<Secrets>(tenant.secrets, tenant.id);
    if (previous.telegramTokenDigest === fingerprint) {
      return;
    }
    const saved = await this.request(tenant, "/v1/credentials/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "telegram",
        field: "bot_token",
        value: this.config.TELEGRAM_BOT_TOKEN,
      }),
    });
    if (!saved.ok) {
      throw new Error("Telegram credential update failed");
    }
    const sandbox = await this.sandbox(tenant);
    const stopped = await sandbox.process.executeCommand(
      "bun /opt/vellum/cli/src/index.ts sleep hosted-demo",
      "/opt/vellum",
      { VELLUM_ENVIRONMENT: "local" },
      120,
    );
    if (stopped.exitCode !== 0) {
      throw new Error("Assistant stop failed during Telegram cutover");
    }
    await this.wake(sandbox, tenant);
    const health = await this.request(tenant, "/healthz");
    if (!health.ok) {
      throw new Error("Assistant health check failed during Telegram cutover");
    }
    const secret = this.store.vault.open<Secrets>(tenant.secrets!, tenant.id);
    secret.telegramTokenDigest = fingerprint;
    tenant.secrets = this.store.vault.seal(secret, tenant.id);
    await this.store.db.query("UPDATE demo_tenants SET secrets=$2 WHERE id=$1", [
      tenant.id, tenant.secrets,
    ]);
  }
  async provision(tenant: Tenant): Promise<void> {
    const sandbox = await this.sandbox(tenant, true);
    await this.store.db.query(
      "UPDATE demo_tenants SET sandbox_id=$2 WHERE id=$1",
      [tenant.id, sandbox.id],
    );
    const result = await sandbox.process.executeCommand(
      "bun /opt/vellum-demo/bootstrap.ts",
      "/opt/vellum",
      {
        DEMO_TELEGRAM_ID: tenant.telegram_id,
        DEMO_PUBLIC_URL: this.config.PUBLIC_BASE_URL,
        DEMO_NOTIFICATION_CHANNEL: tenant.telegram_id.startsWith("whatsapp:") ? "whatsapp" : "telegram",
        DEMO_WEBHOOK_SECRET: randomToken(),
        DEMO_BOT_TOKEN: this.config.TELEGRAM_BOT_TOKEN,
        OPENAI_API_KEY: this.config.OPENAI_API_KEY,
        DEMO_GOOGLE_CLIENT_ID: this.config.GOOGLE_CLIENT_ID,
        DEMO_GOOGLE_CLIENT_SECRET: this.config.GOOGLE_CLIENT_SECRET,
        VELLUM_ENVIRONMENT: "local",
        VELLUM_DISABLE_PLATFORM: "true",
      },
      180,
    );
    if (result.exitCode !== 0) {
      throw new Error("Assistant bootstrap failed");
    }
    const line = result.result
      .split("\n")
      .find((v) => v.startsWith("DEMO_RESULT="));
    if (!line) {
      throw new Error("Assistant bootstrap returned no result");
    }
    const ready = secretsSchema
      .extend({ googleAppId: z.string().min(1) })
      .parse(JSON.parse(line.slice(12)));
    if (this.config.TELEGRAM_UPDATE_BOT_ID) {
      ready.telegramTokenDigest = digest(this.config.TELEGRAM_BOT_TOKEN);
    }
    await this.store.db.query(
      `UPDATE demo_tenants SET secrets=$2,google_app_id=$3,status='active' WHERE id=$1`,
      [tenant.id, this.store.vault.seal(ready, tenant.id), ready.googleAppId],
    );
  }
  async request(
    tenant: Tenant,
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!tenant.secrets || !tenant.sandbox_id) {
      throw new Error("Assistant not provisioned");
    }
    if (
      this.config.HOSTED_INTERACTIVE_AUTO_APPROVE === "true" &&
      (path === "/webhooks/telegram" || path === "/webhooks/whatsapp")
    ) {
      let setup = this.interactivePolicies.get(tenant.id);
      if (!setup) {
        setup = this.request(tenant, "/v1/permissions/thresholds", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interactive: "high" }),
        }).then(async (response) => {
          if (
            !response.ok ||
            ((await response.json()) as { interactive?: string })
              .interactive !== "high"
          ) {
            throw new Error("Hosted interactive policy setup failed");
          }
        });
        this.interactivePolicies.set(tenant.id, setup);
      }
      try {
        await setup;
      } catch (error) {
        this.interactivePolicies.delete(tenant.id);
        throw error;
      }
    }
    if (
      (path === "/webhooks/telegram" || path === "/webhooks/whatsapp")
    ) {
      let setup = this.connectionSkills.get(tenant.id);
      if (!setup) {
        setup = installConnectionSkill(this.config, tenant, this);
        this.connectionSkills.set(tenant.id, setup);
      }
      try {
        await setup;
      } catch {
        this.connectionSkills.delete(tenant.id);
        console.warn(
          "Hosted connection skill setup failed; retrying on the next message",
        );
      }
    }
    const sandbox = await this.sandbox(tenant);
    let introSetup = this.introSetups.get(tenant.id);
    if (!introSetup) {
      introSetup = this.applyHostedIntro(sandbox);
      this.introSetups.set(tenant.id, introSetup);
    }
    try {
      await introSetup;
    } catch {
      this.introSetups.delete(tenant.id);
      console.warn("Hosted intro setup failed; retrying on the next message");
    }
    let secret = this.store.vault.open<Secrets>(tenant.secrets!, tenant.id);
    const preview = await sandbox.getPreviewLink(secret.port);
    if (!preview.token || new URL(preview.url).protocol !== "https:") {
      throw new Error("Private HTTPS preview required");
    }
    const headers = new Headers(options.headers);
    headers.set("X-Daytona-Preview-Token", preview.token);
    headers.set("X-Daytona-Skip-Preview-Warning", "true");
    if (path.startsWith("/v1/")) {
      headers.set("Authorization", `Bearer ${secret.guardianToken}`);
    }
    if (path === "/webhooks/telegram") {
      headers.set("X-Telegram-Bot-Api-Secret-Token", secret.webhookSecret);
    }
    const url = new URL(path, preview.url);
    if (url.origin !== new URL(preview.url).origin) {
      throw new Error("Invalid gateway path");
    }
    let response = await this.fetcher(url, {
      ...options,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
    });
    if (response.status === 401 && path.startsWith("/v1/")) {
      await this.wake(sandbox, tenant);
      secret = this.store.vault.open<Secrets>(tenant.secrets!, tenant.id);
      headers.set("Authorization", `Bearer ${secret.guardianToken}`);
      response = await this.fetcher(url, {
        ...options,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(25_000),
      });
    } else if ([502, 503, 504].includes(response.status)) {
      await this.wake(sandbox, tenant);
      // The durable job owns replay after an ambiguous upstream failure.
    }
    return response;
  }
}
