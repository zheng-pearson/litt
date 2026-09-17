import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalText, normalizeSms, parseConfig } from "./normalize.ts";
import { claim, enqueue, openStore } from "./store.ts";

const config = { accountSid: `AC${"a".repeat(32)}`, phoneNumber: "+12025550100", enabled: true };
const input = { AccountSid: config.accountSid, To: config.phoneNumber, From: "+12025550101", MessageSid: `SM${"b".repeat(32)}`, Body: "Hello Litt", NumMedia: "0" };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

describe("SMS acceptance", () => {
  test("requires the configured account and receiving number", () => {
    expect(normalizeSms(new URLSearchParams(input), config)?.body).toBe("Hello Litt");
    expect(normalizeSms(new URLSearchParams({ ...input, AccountSid: `AC${"c".repeat(32)}` }), config)).toBeNull();
    expect(normalizeSms(new URLSearchParams({ ...input, To: "+12025550102" }), config)).toBeNull();
    expect(normalizeSms(new URLSearchParams({ ...input, From: "anonymous" }), config)).toBeNull();
  });
  test("rejects unsupported media and empty messages", () => {
    expect(normalizeSms(new URLSearchParams({ ...input, Body: " " }), config)).toBeNull();
    expect(normalizeSms(new URLSearchParams({ ...input, NumMedia: "1" }), config)).toBeNull();
    expect(parseConfig({ ...config, enabled: undefined }).enabled).toBe(false);
  });
  test("extracts the final reply without tool and thinking content", () => {
    expect(finalText([{ type: "text", text: "Searching" }, { type: "thinking", text: "private" }, { type: "tool_use" }, { type: "text", text: "Found it" }])).toBe("Found it");
  });
});

test("queue persists across connections and deduplicates retries", () => {
  const directory = mkdtempSync(join(tmpdir(), "litt-sms-test-"));
  directories.push(directory);
  const worker = openStore(directory, true);
  const route = openStore(directory);
  const message = normalizeSms(new URLSearchParams(input), config)!;
  enqueue(route, message);
  enqueue(route, message);
  route.close();
  expect(claim(worker)?.sid).toBe(input.MessageSid);
  expect(claim(worker)).toBeNull();
  worker.close();
  const reopened = openStore(directory);
  expect(reopened.query("SELECT state FROM messages").get()).toEqual({ state: "processing" });
  reopened.close();
});
