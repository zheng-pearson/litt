import { expect, test } from "bun:test";
import { updateHeartbeatGuidance } from "../scripts/update-heartbeat-guidance.js";

test("preserves existing checklist and backs it up before adding connection guidance", async () => {
  let content = "Existing workload instructions";
  const writes: Array<{ path: string; body: any }> = [];
  const request = async (path: string, method = "GET", body?: any) => {
    if (method !== "GET") {
      writes.push({ path, body });
      if (method === "PUT") { content = body.content; }
    }
    return { content };
  };
  expect(await updateHeartbeatGuidance(request)).toBe(true);
  expect(writes[0]?.body.content).toBe("Existing workload instructions");
  expect(content).toStartWith("Existing workload instructions");
  expect(content).toContain("A successful read supersedes an earlier expiration");
  expect(await updateHeartbeatGuidance(request)).toBe(false);
  expect(writes).toHaveLength(2);
});

test("refuses to overwrite a checklist changed while preparing the backup", async () => {
  let reads = 0;
  let puts = 0;
  await expect(updateHeartbeatGuidance(async (_path, method = "GET") => {
    if (method === "PUT") { puts++; }
    if (method === "GET") { reads++; }
    return { content: reads > 1 ? "User edit" : "Original" };
  })).rejects.toThrow("changed during preparation");
  expect(puts).toBe(0);
});
