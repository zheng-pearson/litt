import { describe, expect, test } from "bun:test";
import { reconstructTime } from "../partner-workflows/scripts/time-entries.js";

function entry(id = "entry-1", start = "2026-09-17T09:00:00-07:00", end = "2026-09-17T09:30:00-07:00") {
  return {
    id, matter: "matter-123", narrative: "Review financing conditions.",
    sources: ["call-123"], basis: "recorded", intervals: [{ start, end }],
  };
}

describe("time reconstruction", () => {
  test("keeps proposals unapproved and unknown durations out of totals", () => {
    const result = reconstructTime({ entries: [entry(), { ...entry("entry-2"), basis: "unknown", intervals: [] }] });
    expect(result.knownMinutes).toBe(30);
    expect(result.unconfirmedDurations).toBe(1);
    expect(result.entries[1]!.minutes).toBeNull();
    expect(result.entries.every((item) => item.status === "proposed")).toBe(true);
  });

  test("unions evidence within one entry without double counting", () => {
    const result = reconstructTime({ entries: [{ ...entry(), sources: ["call-123", "call-123"], intervals: [
      ...entry().intervals,
      { start: "2026-09-17T09:15:00-07:00", end: "2026-09-17T09:45:00-07:00" },
    ] }] });
    expect(result.knownMinutes).toBe(45);
    expect(result.entries[0]!.sources).toEqual(["call-123"]);
  });

  test("rejects double billing across matters and timezone representations", () => {
    expect(() => reconstructTime({ entries: [entry(), { ...entry("entry-2", "2026-09-17T16:15:00Z", "2026-09-17T16:45:00Z"), matter: "matter-456" }] })).toThrow("Overlapping work");
  });

  test("allows adjacent work and preserves fractional minutes", () => {
    const result = reconstructTime({ entries: [entry(), entry("entry-2", "2026-09-17T09:30:00-07:00", "2026-09-17T09:30:30-07:00")] });
    expect(result.knownMinutes).toBe(30.5);
  });

  test("handles daylight saving offsets as elapsed time", () => {
    const result = reconstructTime({ entries: [entry("entry-1", "2026-11-01T01:30:00-07:00", "2026-11-01T01:30:00-08:00")] });
    expect(result.knownMinutes).toBe(60);
  });

  test.each([
    "2026-02-30T09:00:00Z", "2026-09-17T24:00:00Z", "2026-09-17T09:00:00", "invalid",
  ])("rejects invalid or ambiguous timestamp %s", (start) => {
    expect(() => reconstructTime({ entries: [entry("entry-1", start)] })).toThrow();
  });

  test("rejects reversed intervals, duplicate IDs, missing sources, and invented duration bases", () => {
    expect(() => reconstructTime({ entries: [entry("entry-1", "2026-09-17T10:00:00-07:00")] })).toThrow();
    expect(() => reconstructTime({ entries: [entry(), entry()] })).toThrow("Duplicate");
    expect(() => reconstructTime({ entries: [{ ...entry(), sources: [] }] })).toThrow("source");
    expect(() => reconstructTime({ entries: [{ ...entry(), basis: "estimated" }] })).toThrow("basis");
    expect(() => reconstructTime({ entries: [{ ...entry(), basis: "unknown" }] })).toThrow("no intervals");
  });

  test("empty activity is an empty proposal, not fabricated time", () => {
    expect(reconstructTime({ entries: [] }).knownMinutes).toBe(0);
  });

  test("CLI validates piped input without external services", () => {
    const result = Bun.spawnSync([process.execPath, "run", `${import.meta.dir}/../partner-workflows/scripts/time-entries.ts`], {
      stdin: Buffer.from(JSON.stringify({ entries: [entry()] })), windowsHide: true,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).knownMinutes).toBe(30);
  });
});
