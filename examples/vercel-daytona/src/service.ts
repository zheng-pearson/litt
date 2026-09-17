import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { DaytonaRuntime } from "./runtime.js";
import { Vault } from "./security.js";
import { database, Store } from "./store.js";
import { sendTelegram } from "./telegram.js";
import { Worker } from "./worker.js";

export function service(background: (work: Promise<void>) => void) {
  const config = readConfig();
  const store = new Store(
    database(config.DATABASE_URL),
    new Vault(config.ENCRYPTION_KEY),
  );
  const runtime = new DaytonaRuntime(config, store);
  const worker = new Worker(config, store, runtime, (id, text) =>
    sendTelegram(config.TELEGRAM_BOT_TOKEN, id, text),
  );
  return createApp(config, store, runtime, worker, background);
}
