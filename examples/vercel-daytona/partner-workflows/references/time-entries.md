# Time entry reconstruction

Resolve the partner's date and timezone. Read calendar, actual calls, sent and received email, and accessible document activity for that local day. Cross-reference matters using the shared source ledger. Do not assume an invitation was attended, a document's open-to-close span was active work, or time between emails was billable.

Group evidenced work into proposed entries with a matter, useful client-facing narrative, source references, and duration basis. An actual recorded interval can support a duration. Point events and calendar plans need the partner's duration or attendance confirmation. Never infer billable minutes from email counts or file modification timestamps.

Prepare JSON for `scripts/time-entries.ts` using this shape:

```json
{
  "entries": [
    {
      "id": "entry-1",
      "matter": "matter-123",
      "narrative": "Conference with client regarding financing conditions.",
      "sources": ["call-123"],
      "basis": "recorded",
      "intervals": [{"start": "2026-09-17T09:00:00-07:00", "end": "2026-09-17T09:30:00-07:00"}]
    },
    {
      "id": "entry-2",
      "matter": "matter-123",
      "narrative": "Review correspondence concerning closing deliverables.",
      "sources": ["email-123"],
      "basis": "unknown",
      "intervals": []
    }
  ]
}
```

Run `bun scripts/time-entries.ts < proposals.json`. The helper combines overlapping spans within an entry, rejects overlaps between entries (even across matters), rejects invalid dates, and leaves unknown durations blank. Split or correct overlapping work with evidence before proposing totals. `confirmed` basis means the partner explicitly confirmed actual work intervals. Use `unknown` until then.

Present numbered entries: matter, exact unrounded minutes when known, narrative. Put unverified durations under "Confirm duration." Show the known-duration subtotal separately; unknown entries are excluded. Do not round up or silently apply a billing increment. Apply the firm's evidenced billing policy only after the partner confirms actual time and nonbillable exclusions.

Allow approval or edits by entry number. Keep approved entries and pending entries distinct; changing narrative, matter, or duration invalidates approval of that entry. Approval in Telegram is not proof of submission to a billing system. Only submit through an available authorized billing capability on an explicit request; otherwise return the approved entries for export. Retain source-linked activity facts for future matter recall, without duplicating sensitive raw content.
