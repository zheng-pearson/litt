import { readConfig } from "../src/config.js";
import { registerTelegramWebhook } from "../src/telegram-cutover.js";

if (!process.argv.includes("--approved-cutover")) {
  throw new Error(
    "Webhook cutover needs explicit consent. Pass --approved-cutover only after obtaining it.",
  );
}
const config = readConfig();
await registerTelegramWebhook(config);
console.log("Telegram webhook registered");
