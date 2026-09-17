import { join } from "node:path";

// Runs inside the private sandbox. Guardian credentials never reach a browser.
const root = "/opt/vellum";
process.env.VELLUM_ENVIRONMENT = "local";
process.env.VELLUM_DISABLE_PLATFORM = "true";
const { findAssistantByName } = await import(
  join(root, "cli/src/lib/assistant-config.ts")
);
const { loadGuardianToken, refreshGuardianToken, guardianTokenDueForRenewal } =
  await import(join(root, "cli/src/lib/guardian-token.ts"));
const name = "hosted-demo";

async function cli(args: string[]) {
  const child = Bun.spawn(["bun", join(root, "cli/src/index.ts"), ...args], {
    cwd: root,
    env: process.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  if ((await child.exited) !== 0) {
    throw new Error(`Assistant lifecycle step failed: ${args[0]}`);
  }
}

async function main() {
  let instance = findAssistantByName(name);
  if (!instance) {
    if (process.argv.includes("--wake")) {
      throw new Error("Assistant state missing; refusing to replace it");
    }
    await cli([
      "hatch",
      "--name",
      name,
      "-d",
      "--disable-platform",
      "--config",
      "telegram.webhookManaged=false",
      "--config",
      `ingress.publicBaseUrl=${process.env.DEMO_PUBLIC_URL}`,
      "--config",
      "llm.default.provider=openai",
      "--config",
      "llm.defaultProvider.provider=openai",
      "--config",
      "llm.activeProfile=balanced",
      "--config",
      "services.google-oauth.mode=your-own",
      "--config",
      "ui.userTimezone=America/Los_Angeles",
      "--config",
      "heartbeat.timezone=America/Los_Angeles",
      "--config",
      `notifications.defaultChannels=${JSON.stringify([process.env.DEMO_NOTIFICATION_CHANNEL === "whatsapp" ? "whatsapp" : "telegram"])}`,
    ]);
    instance = findAssistantByName(name);
  } else {
    await cli(["wake", name]);
  }
  if (!instance?.localUrl) {
    throw new Error("Assistant gateway unavailable");
  }
  let token = loadGuardianToken(instance.assistantId);
  if (token && guardianTokenDueForRenewal(token)) {
    token = await refreshGuardianToken(instance.localUrl, instance.assistantId);
  }
  if (!token?.accessToken) {
    throw new Error("Assistant pairing unavailable");
  }
  if (process.argv.includes("--wake")) {
    console.log(
      `DEMO_TOKEN=${JSON.stringify({ guardianToken: token.accessToken })}`,
    );
    return;
  }
  async function post(path: string, body: unknown) {
    const response = await fetch(`${instance.localUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Assistant setup endpoint failed (${response.status})`);
    }
    return response.json();
  }
  const connection = await fetch(
    `${instance.localUrl}/v1/inference/provider-connections/openai-personal`,
    {
      headers: { Authorization: `Bearer ${token.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (connection.status === 404) {
    await post("/v1/inference/provider-connections", {
      name: "openai-personal",
      provider: "openai",
      auth: { type: "api_key", credential: "credential/openai/api_key" },
    });
  } else if (!connection.ok) {
    throw new Error("Assistant provider connection unavailable");
  }
  for (const [field, value] of [
    ["bot_token", process.env.DEMO_BOT_TOKEN],
    ["webhook_secret", process.env.DEMO_WEBHOOK_SECRET],
  ]) {
    if (!value) {
      throw new Error("Telegram configuration missing");
    }
    await post("/v1/credentials/set", { service: "telegram", field, value });
  }
  const primary = process.env.DEMO_TELEGRAM_ID!;
  const whatsapp = primary.startsWith("whatsapp:");
  await post("/v1/contacts/guardian/channel", {
    type: whatsapp ? "whatsapp" : "telegram",
    address: whatsapp ? primary.slice(9) : primary,
    externalUserId: whatsapp ? primary.slice(9) : primary,
    status: "active",
  });
  const google = (await post("/v1/oauth/apps", {
    provider_key: "google",
    client_id: process.env.DEMO_GOOGLE_CLIENT_ID,
    client_secret: process.env.DEMO_GOOGLE_CLIENT_SECRET,
  })) as { app: { id: string } };
  await cli(["sleep", name]);
  await cli(["wake", name]);
  const health = await fetch(`${instance.localUrl}/healthz`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!health.ok) {
    throw new Error("Assistant health check failed");
  }
  console.log(
    `DEMO_RESULT=${JSON.stringify({
      guardianToken: token.accessToken,
      webhookSecret: process.env.DEMO_WEBHOOK_SECRET,
      port: Number(new URL(instance.localUrl).port),
      googleAppId: google.app.id,
    })}`,
  );
}

try {
  await main();
} catch {
  console.error(
    "Demo bootstrap failed. Inspect the sandbox assistant logs without exporting credentials.",
  );
  process.exitCode = 1;
}
