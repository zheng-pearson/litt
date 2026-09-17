import { z } from "zod";

export const NotificationsConfigSchema = z
  .object({
    defaultChannels: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Delivery channels for assistant notifications that do not specify a destination. An empty list preserves the standard internal-inbox default.",
      ),
  })
  .describe(
    "Notification delivery configuration. Model selection lives under llm.callSites.notificationDecision and llm.callSites.preferenceExtraction.",
  );

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
