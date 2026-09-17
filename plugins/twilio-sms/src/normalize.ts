export interface SmsConfig { accountSid: string; phoneNumber: string; enabled: boolean }

export function parseConfig(value: unknown): SmsConfig {
  const config = value as Partial<SmsConfig> | null;
  if (!config || !/^AC[0-9a-f]{32}$/i.test(config.accountSid ?? "") || !/^\+[1-9]\d{7,14}$/.test(config.phoneNumber ?? "")) {
    throw new Error("Set accountSid and phoneNumber in the Twilio SMS plugin config.");
  }
  return { accountSid: config.accountSid!, phoneNumber: config.phoneNumber!, enabled: config.enabled === true };
}

export function normalizeSms(params: URLSearchParams, config: SmsConfig) {
  const sid = params.get("MessageSid") ?? "";
  const sender = params.get("From") ?? "";
  const recipient = params.get("To") ?? "";
  const body = params.get("Body") ?? "";
  if (params.get("AccountSid") !== config.accountSid || recipient !== config.phoneNumber ||
      !/^SM[0-9a-f]{32}$/i.test(sid) || !/^\+[1-9]\d{7,14}$/.test(sender)) {
    return null;
  }
  if (!body.trim() || body.length > 16000 || Number(params.get("NumMedia") ?? "0") > 0) {
    return null;
  }
  return { sid, sender, recipient, body };
}

export function finalText(blocks: Array<{ type: string; text?: string }>): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === "text") {
      return blocks[i].text?.trim() ?? "";
    }
  }
  return "";
}
