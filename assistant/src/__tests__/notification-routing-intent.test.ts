/**
 * Tests for fire-time routing intent enforcement.
 *
 * Validates that the post-decision enforcement step correctly overrides
 * the decision engine's channel selection based on the routing intent
 * persisted on the reminder at create time.
 */

import { describe, expect, test } from "bun:test";

import { enforceRoutingIntent } from "../notifications/decision-engine.js";
import type {
  NotificationChannel,
  NotificationDecision,
} from "../notifications/types.js";

// -- Helpers -----------------------------------------------------------------

function makeDecision(
  overrides?: Partial<NotificationDecision>,
): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ["vellum"],
    reasoningSummary: "LLM selected vellum only",
    renderedCopy: {
      vellum: { title: "Reminder", body: "Test reminder" },
    },
    dedupeKey: "routing-test-001",
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

// -- Tests -------------------------------------------------------------------

describe("routing intent enforcement", () => {
  describe("explicit single-channel preferences", () => {
    for (const key of ["preferred_channels", "preferredChannels"]) {
      test(`${key} preserves Telegram after urgency prepends vellum`, () => {
        const enforced = enforceRoutingIntent(
          makeDecision({ selectedChannels: ["vellum", "telegram"] }),
          "single_channel",
          ["vellum", "telegram"],
          "scheduler",
          { [key]: ["telegram"] },
        );
        expect(enforced.selectedChannels).toEqual(["telegram"]);
      });
    }

    test("ignores unavailable and malformed preferences", () => {
      const enforced = enforceRoutingIntent(
        makeDecision(),
        "single_channel",
        ["vellum", "telegram"],
        "telegram",
        { preferred_channels: [null, 42, "slack"] },
      );
      expect(enforced.selectedChannels).toEqual(["telegram"]);
    });

    test("does not invent a channel for an empty decision", () => {
      const enforced = enforceRoutingIntent(
        makeDecision({ selectedChannels: [] }),
        "single_channel",
        [],
        "scheduler",
      );
      expect(enforced.selectedChannels).toEqual([]);
    });
  });

  describe("all_channels intent", () => {
    test("forces selection to all connected channels", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      expect(enforced.reasoningSummary).toContain(
        "routing_intent=all_channels",
      );
    });

    test("selects all channels even when LLM picked none", () => {
      const decision = makeDecision({ selectedChannels: [] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      // shouldNotify must be true for enforcement to apply
      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );
      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
    });

    test("does not modify decision when shouldNotify is false", () => {
      const decision = makeDecision({
        shouldNotify: false,
        selectedChannels: [],
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      expect(enforced.shouldNotify).toBe(false);
      expect(enforced.selectedChannels).toEqual([]);
    });

    test("single connected channel selects that channel", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );
      expect(enforced.selectedChannels).toEqual(["vellum"]);
    });

    test("includes all connected channels in all_channels mode", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram", "slack"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      expect(enforced.selectedChannels).toEqual([
        "vellum",
        "telegram",
        "slack",
      ]);
      expect(enforced.reasoningSummary).toContain(
        "routing_intent=all_channels",
      );
    });

    test("excludes disconnected channels from all_channels", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      expect(enforced.selectedChannels).not.toContain("slack");
    });
  });

  describe("multi_channel intent", () => {
    test("expands to at least two channels when LLM picked fewer than 2 and 2+ are connected", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      expect(enforced.reasoningSummary).toContain(
        "routing_intent=multi_channel",
      );
    });

    test("does not expand to all channels when 3+ are connected", () => {
      const decision = makeDecision({ selectedChannels: ["telegram"] });
      const connected: NotificationChannel[] = ["vellum", "telegram", "slack"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["telegram", "vellum"]);
      expect(enforced.selectedChannels).not.toContain("slack");
    });

    test("does not override when LLM already picked 2+ channels", () => {
      const decision = makeDecision({
        selectedChannels: ["vellum", "telegram"],
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      // No enforcement annotation since decision already satisfied the intent
      expect(enforced.reasoningSummary).not.toContain(
        "routing_intent=multi_channel",
      );
    });

    test("does not expand when only 1 channel is connected", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      // Cannot expand to 2+ when only 1 is available
      expect(enforced.selectedChannels).toEqual(["vellum"]);
    });

    test("does not modify decision when shouldNotify is false", () => {
      const decision = makeDecision({
        shouldNotify: false,
        selectedChannels: [],
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      expect(enforced.shouldNotify).toBe(false);
      expect(enforced.selectedChannels).toEqual([]);
    });
  });

  describe("single_channel intent", () => {
    test("does not modify the decision", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "single_channel",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum"]);
      expect(enforced.reasoningSummary).toBe(decision.reasoningSummary);
    });

    // Reproduces a scheduled reminder firing: `schedule.notify` emits with
    // `urgency: "high"`, so step 2.5a in emit-signal prepends `vellum` before
    // enforcement runs. The source channel is `scheduler`, which is not a
    // deliverable channel, so the cap falls back to the first selected
    // channel and lands on the internal inbox instead of the channel the
    // reminder was created to reach.
    test("scheduled reminder with a preferred channel is capped to that channel, not the urgency-prepended inbox", () => {
      const decision = makeDecision({
        selectedChannels: ["vellum", "telegram"],
        reasoningSummary: "LLM selected telegram (vellum forced: high urgency)",
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "single_channel",
        connected,
        "scheduler",
        { preferred_channels: ["telegram"] },
      );

      expect(enforced.selectedChannels).toEqual(["telegram"]);
    });
  });

  describe("undefined routing intent", () => {
    test("does not modify the decision", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(decision, undefined, connected);

      expect(enforced.selectedChannels).toEqual(["vellum"]);
    });
  });

  describe("copy generation at fire time", () => {
    test("existing rendered copy is preserved through enforcement", () => {
      const decision = makeDecision({
        selectedChannels: ["vellum"],
        renderedCopy: {
          vellum: { title: "Reminder", body: "Pick up groceries" },
        },
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      // Channels expanded but copy from LLM is preserved
      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      expect(enforced.renderedCopy.vellum?.body).toBe("Pick up groceries");
    });
  });
});
