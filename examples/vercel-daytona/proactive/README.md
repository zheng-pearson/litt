# Workload-driven proactive reviews

The requested behavior uses hourly reviews, a morning brief initially at 7 AM,
and an evening summary initially at 6 PM in the user's timezone. The assistant
adapts brief times from the user's routine. Urgency is assessed by the assistant
from fresh calendar, email and conversation context. Unanswered, unchanged items
do not earn another message. Watchers and scheduled event wakes handle relevant
changes between hourly reviews.

`config.json` configures the existing heartbeat scheduler. `HEARTBEAT.md` is the
workload policy and describes the compact persistent context and alert history.
`heartbeat.engagementPrompts=false` requires the corresponding assistant code
update. Its default is true so other assistants keep their existing behavior.

To install on a selected assistant, supply its HTTPS gateway URL and operator
token as `ASSISTANT_GATEWAY_URL` and `ASSISTANT_GATEWAY_TOKEN` outside the repository.
Run `bun scripts/configure-proactive.ts` to preview, then add `--apply` to install.
The installer verifies version support before writing, reads back settings, and
attempts restoration if a write fails. It does not install watchers or perform
a notification test. It replaces the selected assistant's heartbeat checklist.

## Verification still required before declaring live completion

- Deploy the assistant version with the engagement setting and install the policy.
- Verify next scheduled review and two consecutive hourly run records.
- Verify connected email/calendar reads and durable compact context.
- Verify morning and evening briefs each send once per local date, including
  an earlier user message and adaptation of the morning time.
- Verify ordinary items stay silent, a new urgent item alerts, and the same
  item produces no second message when the user does not reply.
- Verify watchers and event wakes are actually registered, share alert history,
  and suppress events already mentioned. Exercise cancellation and rescheduling.
- Verify timezone, quiet hours, provider failure and ambiguous delivery recovery.

Configuration validation and mocked tests alone do not prove these live behaviors.
