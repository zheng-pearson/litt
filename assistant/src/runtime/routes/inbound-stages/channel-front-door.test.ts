import { beforeEach, expect, mock, test } from "bun:test";

import { z } from "zod";

import type { BackgroundProcessingParams } from "./background-dispatch.js";
import type { FrontDoorState } from "./channel-front-door-store.js";
const states = new Map<string, FrontDoorState>();
const sent: string[] = [];
const stopped: string[] = [];
let serial = 0;
let enabled = true;
let deliver = async () => {};
mock.module("../../../config/loader.js", () => ({
  getConfigReadOnly: () => ({
    telegram: {
      concurrentReplies: enabled,
      hostedConnectionEndpoint: "https://example.com/integrations/connect",
    },
  }),
}));
mock.module("../../../oauth/oauth-store.js", () => ({
  getConnectionByProvider: () => undefined,
}));
mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: async () => ({ value: "test-capability" }),
}));
mock.module("../../../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => ({
    getMessages: () => [],
    abort: () => {
      stopped.push(id);
    },
  }),
}));
mock.module("../../../persistence/conversation-crud.js", () => ({
  addMessage: async () => ({}),
  provenanceFromTrustContext: () => ({}),
  createConversation: () => ({ id: `task-${++serial}` }),
  getMessagesPaginated: () => ({ messages: [] }),
}));
mock.module("../../../persistence/delivery-status.js", () => ({
  markProcessed: () => {},
  markDeliveryDelivered: () => {},
}));
mock.module("../../../providers/provider-send-message.js", () => ({
  extractToolUse: () => undefined,
  getConfiguredProvider: async () => null,
  userMessage: (text: string) => text,
}));
mock.module("../../gateway-client.js", () => ({
  deliverChannelReply: async (_url: string, payload: { text: string }) => {
    await deliver();
    sent.push(payload.text);
    return { ok: true };
  },
}));
mock.module("./channel-front-door-store.js", () => ({
  completeFrontDoorTask: (id: string) => {
    const state = states.get(id);
    if (state) {
      states.set(id, { ...state, completed: true });
    }
  },
  frontDoorDecisionSchema: z.object({
    reply: z.string(),
    action: z.enum(["answer", "start", "revise", "stop"]),
    targetEventId: z.string().nullable(),
  }),
  frontDoorRoot: (id: string) => id,
  readFrontDoorState: (id: string) => states.get(id),
  saveFrontDoorState: (id: string, state: FrontDoorState) => {
    states.set(id, state);
  },
  recentFrontDoorStates: (root: string) =>
    [...states.entries()]
      .filter(([, state]) => state.rootConversationId === root)
      .map(([eventId, state]) => ({
        eventId,
        content: "Research the deal",
        state,
      })),
}));
mock.module("../../../notifications/delivered-post-record.js", () => ({
  recordDeliveredChannelPost: async () => ({ messageId: "reply-123" }),
}));
const {
  hostedConnectionReply,
  runFrontDoor,
  shouldUseFrontDoor,
  waitForFrontDoorResponses,
} = await import("./channel-front-door.js");
function params(eventId: string): BackgroundProcessingParams {
  return {
    eventId,
    conversationId: "chat-123",
    content: "New question",
    sourceChannel: "telegram",
    sourceInterface: "telegram",
    externalChatId: "chat-123",
    chatType: "private",
    metadataHints: [],
    replyCallbackUrl: "telegram://chat-123",
    trustCtx: {
      sourceChannel: "telegram",
      trustClass: "guardian",
      guardianExternalUserId: "user-123",
      requesterExternalUserId: "user-123",
    },
    processMessage: async () => ({ messageId: "message-123" }),
  };
}
beforeEach(() => {
  states.clear();
  sent.length = 0;
  stopped.length = 0;
  serial = 0;
  enabled = true;
  deliver = async () => {};
});
async function start() {
  return runFrontDoor(params("research"), async () => ({
    reply: "Retrieving your deal updates now. Hang tight!",
    action: "start",
    targetEventId: null,
  }));
}
test("an independent answer is delivered while research stays active", async () => {
  const work = await start();
  expect(work?.conversationId).toBe("task-1");
  const reply = await runFrontDoor(params("question"), async () => ({
    reply: "Yes, the draft remains unsent.",
    action: "answer",
    targetEventId: null,
  }));
  expect(reply).toBeNull();
  expect(sent).toEqual([
    "Retrieving your deal updates now. Hang tight!",
    "Yes, the draft remains unsent.",
  ]);
  expect(stopped).toEqual([]);
  expect(states.get("research")?.completed).toBe(false);
});
test("a separate retrieval uses its own conversation", async () => {
  const first = await start();
  const next = await runFrontDoor(params("second"), async () => ({
    reply: "Checking your calendar now.",
    action: "start",
    targetEventId: null,
  }));
  expect(next?.conversationId).not.toBe(first?.conversationId);
  expect(stopped).toEqual([]);
});
test("revision answers first and blocks the old final until the decision applies", async () => {
  await start();
  let release!: () => void;
  deliver = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const revision = runFrontDoor(
    { ...params("revision"), content: "Focus only on the cap." },
    async () => ({
      reply: "Yes. I will focus on the cap.",
      action: "revise",
      targetEventId: "research",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stopped).toEqual([]);
  expect(states.get("research")?.suppressed).toBe(false);
  let released = false;
  const barrier = waitForFrontDoorResponses("research").then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(released).toBe(false);
  release();
  const work = await revision;
  await barrier;
  expect(stopped).toEqual(["task-1"]);
  expect(states.get("research")?.suppressed).toBe(true);
  expect(work?.content).toContain("Previous task:");
  expect(work?.content).toContain("Focus only on the cap.");
});
test("stop does not start another retrieval", async () => {
  await start();
  expect(
    await runFrontDoor(params("stop"), async () => ({
      reply: "Stopping that research.",
      action: "stop",
      targetEventId: "research",
    })),
  ).toBeNull();
  expect(stopped).toEqual(["task-1"]);
  expect(states.get("research")?.suppressed).toBe(true);
});
test("retry reuses its task and does not repeat the initial reply", async () => {
  const first = await start();
  const next = await runFrontDoor(params("research"), async () => {
    throw new Error("Must not classify a retry");
  });
  expect(next?.conversationId).toBe(first?.conversationId);
  expect(sent).toHaveLength(1);
});
test("cannot revise another conversation's task", async () => {
  await start();
  await expect(
    runFrontDoor(
      { ...params("attack"), conversationId: "other-chat" },
      async () => ({
        reply: "Changing it.",
        action: "revise",
        targetEventId: "research",
      }),
    ),
  ).rejects.toThrow("unavailable task");
  expect(stopped).toEqual([]);
});
test("only enabled private guardian messages use this path", () => {
  const original = params("one");
  expect(shouldUseFrontDoor(original)).toBe(true);
  expect(shouldUseFrontDoor({ ...original, chatType: "group" })).toBe(false);
  expect(
    shouldUseFrontDoor({
      ...original,
      trustCtx: { ...original.trustCtx, requesterExternalUserId: "other" },
    }),
  ).toBe(false);
  expect(shouldUseFrontDoor({ ...original, replyCallbackUrl: undefined })).toBe(
    false,
  );
  enabled = false;
  expect(shouldUseFrontDoor(original)).toBe(false);
});
test("failed delivery cannot mark a message answered or cancel its target", async () => {
  await start();
  deliver = async () => {
    throw new Error("offline");
  };
  await expect(
    runFrontDoor(params("stop"), async () => ({
      reply: "Stopping it.",
      action: "stop",
      targetEventId: "research",
    })),
  ).rejects.toThrow("offline");
  expect(states.get("stop")?.replied).toBe(false);
  expect(stopped).toEqual([]);
});

test("routing receives authoritative completed status instead of historical running claims", async () => {
  await start();
  states.set("research", { ...states.get("research")!, completed: true });
  await runFrontDoor(params("status"), async (prompt) => {
    const context = JSON.parse(prompt);
    expect(context.activeTasks).toEqual([]);
    expect(context.currentConnectionRecords.google.hasActiveConnection).toBe(
      false,
    );
    expect(context.recentExchanges[0].status).toBe("completed");
    return {
      reply: "The research is complete.",
      action: "answer",
      targetEventId: null,
    };
  });
});

test("explicit reconnect returns a hosted link without starting a task or changing account access", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    options?: RequestInit,
  ) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return Response.json({
      url: "https://example.com/connect?ticket=test-ticket",
    });
  }) as typeof fetch;
  try {
    const work = await runFrontDoor(params("reconnect"), async () => ({
      action: "connect",
      workflow: "connections",
      provider: "pearson",
      service: null,
      targetEventId: null,
      reply: "[Reconnect Pearson]({{connection_url}}).",
    }));
    expect(work).toBeNull();
    expect(sent).toEqual([
      "[Reconnect Pearson](https://example.com/connect?ticket=test-ticket).",
    ]);
    expect(calls).toEqual([
      {
        url: "https://example.com/integrations/connect",
        body: { provider: "pearson", conversationId: "chat-123" },
      },
    ]);
    expect(serial).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connection response rejects a generic OAuth or foreign callback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      url: "https://accounts.example.org/oauth?redirect_uri=http://localhost:17321",
    })) as unknown as typeof fetch;
  try {
    await expect(
      hostedConnectionReply(
        {
          action: "connect",
          provider: "google",
          service: "gmail",
          targetEventId: null,
          reply: "[Connect Gmail]({{connection_url}})",
        },
        "chat-123",
      ),
    ).rejects.toThrow("unexpected link");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
