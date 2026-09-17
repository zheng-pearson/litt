type Interval = { start: number; end: number };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function timestamp(value: unknown): number {
  const raw = text(value, "Timestamp");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new Error("Timestamps require ISO dates with explicit timezone offsets.");
  }
  const parsed = Date.parse(raw);
  const date = raw.substring(0, 10);
  const day = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed) || !Number.isFinite(day.getTime()) || day.toISOString().substring(0, 10) !== date || Number(raw.substring(11, 13)) > 23) {
    throw new Error("Invalid timestamp.");
  }
  return parsed;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const span of intervals.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function reconstructTime(input: unknown) {
  const data = object(input);
  if (!Array.isArray(data.entries) || data.entries.length > 500) {
    throw new Error("entries must be an array of at most 500 proposed entries.");
  }
  const ids = new Set<string>();
  const occupied: (Interval & { id: string })[] = [];
  const entries = data.entries.map((value: unknown) => {
    const entry = object(value);
    const id = text(entry.id, "id");
    if (ids.has(id)) {
      throw new Error(`Duplicate entry ID: ${id}`);
    }
    ids.add(id);
    const matter = text(entry.matter, "matter");
    const narrative = text(entry.narrative, "narrative");
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
      throw new Error(`${id}: supply source references.`);
    }
    const sources = [...new Set(entry.sources.map((source: unknown) => text(source, "source")))];
    if (!["recorded", "confirmed", "unknown"].includes(String(entry.basis))) {
      throw new Error(`${id}: basis must be recorded, confirmed, or unknown.`);
    }
    if (!Array.isArray(entry.intervals) || entry.intervals.length > 1000) {
      throw new Error(`${id}: intervals must be an array of at most 1000 spans.`);
    }
    if ((entry.basis === "unknown") !== (entry.intervals.length === 0)) {
      throw new Error(`${id}: unknown durations need no intervals; recorded or confirmed work needs intervals.`);
    }
    const intervals = mergeIntervals(entry.intervals.map((value: unknown) => {
      const span = object(value);
      const start = timestamp(span.start);
      const end = timestamp(span.end);
      if (end <= start || end - start > 86_400_000) {
        throw new Error(`${id}: each interval must be positive and at most 24 hours.`);
      }
      return { start, end };
    }));
    for (const interval of intervals) {
      occupied.push({ ...interval, id });
    }
    const seconds = intervals.reduce((total, span) => total + (span.end - span.start) / 1000, 0);
    return {
      id, matter, narrative, sources, basis: entry.basis,
      status: "proposed" as const,
      seconds: entry.basis === "unknown" ? null : seconds,
      minutes: entry.basis === "unknown" ? null : seconds / 60,
      intervals: intervals.map((span) => ({ start: new Date(span.start).toISOString(), end: new Date(span.end).toISOString() })),
    };
  });
  occupied.sort((a, b) => a.start - b.start);
  for (let index = 1; index < occupied.length; index++) {
    const previous = occupied[index - 1]!;
    const current = occupied[index]!;
    if (current.start < previous.end) {
      throw new Error(`Overlapping work in ${previous.id} and ${current.id}. Resolve before proposing totals.`);
    }
  }
  const knownSeconds = entries.reduce((total, entry) => total + (entry.seconds ?? 0), 0);
  return { ok: true, entries, knownSeconds, knownMinutes: knownSeconds / 60, unconfirmedDurations: entries.filter((entry) => entry.seconds === null).length };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      console.log("Usage: bun scripts/time-entries.ts [input.json]\nReads JSON from stdin when no file is supplied. Returns proposed entries and unrounded known durations; rejects overlapping work. See references/time-entries.md for the input schema.");
    } else {
      if (args.length > 1 || args[0]?.startsWith("--")) {
        throw new Error("Supply one JSON file or pipe JSON through stdin. Use --help for usage.");
      }
      const raw = args[0] ? await Bun.file(args[0]).text() : await Bun.stdin.text();
      console.log(JSON.stringify(reconstructTime(JSON.parse(raw))));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Time reconstruction failed." }));
    process.exitCode = 1;
  }
}
