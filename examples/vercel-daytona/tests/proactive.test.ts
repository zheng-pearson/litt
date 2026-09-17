import { expect, test } from "bun:test";
import { configureProactive } from "../scripts/configure-proactive.js";

test("unsupported assistants are rejected before settings change", async () => {
  const calls: string[] = [];
  await expect(
    configureProactive(
      async (path) => {
        calls.push(path);
        return { schema: {} };
      },
      { enabled: true },
      "workload",
    ),
  ).rejects.toThrow("Upgrade");
  expect(calls).toEqual(["/v1/config/schema?path=heartbeat.engagementPrompts"]);
});

test("installs policy before enabling and preserves unrelated heartbeat settings", async () => {
  let heartbeat: Record<string, unknown> = {
    enabled: true,
    futureSetting: "preserve",
  };
  let checklist = "original";
  const changes: string[] = [];
  await configureProactive(
    async (path, method = "GET", body?: any) => {
      if (path.includes("schema")) {
        return { schema: { type: "boolean" } };
      }
      if (path === "/v1/config") {
        return { heartbeat: { ...heartbeat } };
      }
      if (path === "/v1/config/set") {
        heartbeat = body.value;
        changes.push(heartbeat.enabled ? "enable" : "disable");
        return {};
      }
      if (path === "/v1/heartbeat/checklist") {
        if (method === "PUT") {
          checklist = body.content;
          changes.push("checklist");
        }
        return { content: checklist };
      }
      return {};
    },
    { enabled: true, engagementPrompts: false, maxDailyRuns: null },
    "workload",
  );
  expect(changes).toEqual(["disable", "checklist", "enable"]);
  expect(heartbeat.futureSetting).toBe("preserve");
  expect(heartbeat.maxDailyRuns).toBeNull();
  expect(checklist).toBe("workload");
});
