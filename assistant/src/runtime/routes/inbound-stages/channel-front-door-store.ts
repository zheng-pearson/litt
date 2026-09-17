import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../../persistence/db-connection.js";
import {
  channelInboundEvents,
  conversations,
} from "../../../persistence/schema.js";

export const frontDoorDecisionSchema = z.object({
  reply: z.string().min(1).max(1000),
  action: z.enum(["answer", "start", "revise", "stop", "connect"]),
  targetEventId: z.string().nullable(),
  workflow: z.enum(["general", "connections", "partner"]).optional(),
  provider: z.enum(["google", "outlook", "pearson"]).nullable().optional(),
  service: z.enum(["gmail", "calendar", "both"]).nullable().optional(),
});

const stateSchema = frontDoorDecisionSchema.extend({
  rootConversationId: z.string(),
  taskConversationId: z.string().optional(),
  taskContent: z.string().optional(),
  replied: z.boolean().default(false),
  suppressed: z.boolean().default(false),
  completed: z.boolean().default(false),
});
export type FrontDoorDecision = z.infer<typeof frontDoorDecisionSchema>;
export type FrontDoorState = z.infer<typeof stateSchema>;

export function frontDoorRoot(conversationId: string): string {
  const row = getDb()
    .select({
      source: conversations.source,
      parent: conversations.parentConversationId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.source === "telegram_concurrent_task" && row.parent
    ? row.parent
    : conversationId;
}

function payload(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* An absent payload has no front-door state. */
  }
  return {};
}

export function readFrontDoorState(
  eventId: string,
): FrontDoorState | undefined {
  const row = getDb()
    .select({ raw: channelInboundEvents.rawPayload })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();
  const result = stateSchema.safeParse(
    payload(row?.raw ?? null).channelFrontDoor,
  );
  return result.success ? result.data : undefined;
}

export function saveFrontDoorState(
  eventId: string,
  state: FrontDoorState,
): void {
  const db = getDb();
  const row = db
    .select({ raw: channelInboundEvents.rawPayload })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();
  if (!row?.raw) {
    throw new Error("Inbound payload unavailable for concurrent reply");
  }
  db.update(channelInboundEvents)
    .set({
      rawPayload: JSON.stringify({
        ...payload(row.raw),
        channelFrontDoor: stateSchema.parse(state),
      }),
      updatedAt: Date.now(),
      ...(state.taskConversationId
        ? { conversationId: state.taskConversationId }
        : {}),
    })
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}

export function recentFrontDoorStates(rootConversationId: string) {
  return getDb()
    .select({
      eventId: channelInboundEvents.id,
      raw: channelInboundEvents.rawPayload,
    })
    .from(channelInboundEvents)
    .where(
      and(
        or(
          eq(channelInboundEvents.conversationId, rootConversationId),
          sql`json_extract(${channelInboundEvents.rawPayload}, '$.channelFrontDoor.rootConversationId') = ${rootConversationId}`,
        ),
        eq(channelInboundEvents.sourceChannel, "telegram"),
      ),
    )
    .orderBy(desc(channelInboundEvents.createdAt))
    .all()
    .flatMap((row) => {
      const raw = payload(row.raw);
      const state = stateSchema.safeParse(raw.channelFrontDoor);
      return state.success
        ? [
            {
              eventId: row.eventId,
              content: typeof raw.content === "string" ? raw.content : "",
              state: state.data,
            },
          ]
        : [];
    });
}

export function isFrontDoorSuppressed(eventId: string): boolean {
  return readFrontDoorState(eventId)?.suppressed === true;
}

export function completeFrontDoorTask(eventId: string): void {
  const state = readFrontDoorState(eventId);
  if (state) {
    saveFrontDoorState(eventId, { ...state, completed: true });
  }
}

export function claimFrontDoorRetry(eventId: string): void {
  getDb()
    .update(channelInboundEvents)
    .set({
      processingStatus: "pending",
      retryAfter: null,
      updatedAt: Date.now(),
    })
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}
