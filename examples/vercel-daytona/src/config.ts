import { z } from "zod";

const schema = z.object({
  PUBLIC_BASE_URL: z.url().refine((v) => {
    const u = new URL(v);
    return (
      u.protocol === "https:" &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }, "Use an HTTPS origin without a path"),
  PEARSON_MCP_URL: z.url().refine(value => { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/api/second/mcp"; }).optional(),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  CRON_SECRET: z.string().min(32),
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  TELEGRAM_UPDATE_BOT_ID: z.string().regex(/^[1-9]\d*$/).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  DAYTONA_API_KEY: z.string().min(1),
  DAYTONA_SNAPSHOT: z.string().min(1),
  DAYTONA_TARGET: z.string().default("us"),
  HOSTED_INTERACTIVE_AUTO_APPROVE: z.enum(["true", "false"]).default("false"),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(32).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/).optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^\d+$/).optional(),
  WHATSAPP_PHONE_NUMBER: z.string().regex(/^\d+$/).optional(),
  ALLOWED_EMAILS: z.string().min(1),
  PUBLIC_SIGNUP: z.enum(["true", "false"]).default("false"),
  OAUTH_AUTOMATIC_RESUME: z.enum(["true", "false"]).default("false"),
  OPENAI_API_KEY: z.string().min(1),
}).refine(
  (config) => !config.TELEGRAM_UPDATE_BOT_ID ||
    config.TELEGRAM_BOT_TOKEN.startsWith(`${config.TELEGRAM_UPDATE_BOT_ID}:`),
  { path: ["TELEGRAM_UPDATE_BOT_ID"], message: "Update namespace must match the configured bot" },
);

export type Config = z.infer<typeof schema>;
export function readConfig(env = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Missing or invalid configuration: ${[...new Set(result.error.issues.map((i) => i.path[0]))].join(", ")}`,
    );
  }
  return {
    ...result.data,
    PUBLIC_BASE_URL: new URL(result.data.PUBLIC_BASE_URL).origin,
  };
}

export function allowedEmail(config: Config, email: string): boolean {
  if (config.PUBLIC_SIGNUP === "true") {
    return true;
  }
  return config.ALLOWED_EMAILS.split(",")
    .map((v) => v.trim().toLowerCase())
    .includes(email.toLowerCase());
}
