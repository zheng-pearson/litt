import { readFile } from "node:fs/promises";

export async function configureProactive(
  request: (path: string, method?: string, body?: unknown) => Promise<any>,
  heartbeat: Record<string, unknown>,
  checklist: string,
): Promise<void> {
  const capability = await request(
    "/v1/config/schema?path=heartbeat.engagementPrompts",
  );
  if (capability.schema?.type !== "boolean") {
    throw new Error(
      "Upgrade the assistant to support workload-only heartbeats first.",
    );
  }
  const previous = await request("/v1/config");
  const previousChecklist = await request("/v1/heartbeat/checklist");
  const merged = { ...previous.heartbeat, ...heartbeat };
  try {
    await request("/v1/config/set", "POST", {
      path: "heartbeat",
      value: { ...merged, enabled: false },
    });
    await request("/v1/heartbeat/checklist", "PUT", { content: checklist });
    await request("/v1/config/set", "POST", {
      path: "heartbeat",
      value: merged,
    });
    await request("/v1/heartbeat/config", "PUT", { enabled: true });
    const saved = await request("/v1/config");
    const savedChecklist = await request("/v1/heartbeat/checklist");
    for (const [key, value] of Object.entries(heartbeat)) {
      if (JSON.stringify(saved.heartbeat?.[key]) !== JSON.stringify(value)) {
        throw new Error(`Proactive configuration did not persist: ${key}`);
      }
    }
    if (savedChecklist.content !== checklist) {
      throw new Error("Proactive checklist did not persist.");
    }
  } catch (error) {
    try {
      await request("/v1/config/set", "POST", {
        path: "heartbeat",
        value: { ...merged, enabled: false },
      });
      await request("/v1/heartbeat/checklist", "PUT", {
        content: previousChecklist.content ?? "",
      });
      await request("/v1/config/set", "POST", {
        path: "heartbeat",
        value: previous.heartbeat ?? {},
      });
      await request("/v1/heartbeat/config", "PUT", {
        enabled: previous.heartbeat?.enabled ?? true,
      });
    } catch {
      throw new Error(
        "Proactive setup and restoration failed. Inspect heartbeat settings before retrying.",
      );
    }
    throw error;
  }
}

async function main() {
  if (!process.argv.includes("--apply")) {
    console.log(
      "Plan: hourly workload reviews, adaptive 7 AM brief, 6 PM summary, urgency-based alerts and no unchanged repeats. Pass --apply with ASSISTANT_GATEWAY_URL and ASSISTANT_GATEWAY_TOKEN supplied outside the repository to install.",
    );
    return;
  }
  const origin = new URL(process.env.ASSISTANT_GATEWAY_URL ?? "");
  const token = process.env.ASSISTANT_GATEWAY_TOKEN;
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    !token
  ) {
    throw new Error(
      "An HTTPS assistant gateway and operator token are required.",
    );
  }
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(new URL(path, origin.origin), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(
        `Assistant settings request failed (${response.status}).`,
      );
    }
    return response.json();
  };
  const settings = JSON.parse(
    await readFile(
      new URL("../proactive/config.json", import.meta.url),
      "utf8",
    ),
  );
  const checklist = await readFile(
    new URL("../proactive/HEARTBEAT.md", import.meta.url),
    "utf8",
  );
  await configureProactive(request, settings.heartbeat, checklist);
  console.log(
    "Hourly configuration and checklist installed and read back. Live notification behavior still requires verification.",
  );
}

if (import.meta.main) {
  main().catch(() => {
    console.error(
      "Proactive setup failed. Verify gateway access, assistant version, and current heartbeat settings.",
    );
    process.exitCode = 1;
  });
}
