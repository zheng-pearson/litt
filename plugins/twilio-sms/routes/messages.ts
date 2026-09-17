import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeSms, parseConfig } from "../src/normalize.ts";
import { enqueue, openStore } from "../src/store.ts";

export async function POST(request: Request): Promise<Response> {
  const config = parseConfig(JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")));
  if (!config.enabled) {
    return Response.json({ error: "SMS channel is disabled" }, { status: 503 });
  }
  const message = normalizeSms(new URLSearchParams(await request.text()), config);
  if (!message) {
    return Response.json({ error: "Unsupported SMS payload" }, { status: 400 });
  }
  const db = openStore(fileURLToPath(new URL("../data/", import.meta.url)));
  try {
    enqueue(db, message);
    return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
  } finally {
    db.close();
  }
}
