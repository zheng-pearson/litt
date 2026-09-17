# Hosted Outlook verification

## Regression checks

Run `bun test tests/demo.test.ts` and `bunx tsc --noEmit` in this example.
Run the scoped CES process-lifetime, process-manager, and managed-failover tests
in `assistant/` when changing credential process lifecycle.

## Live synthetic-account checks

Use only a designated test mailbox. Send mail only to that same mailbox. Modify
only explicitly synthetic messages and appointments. Refresh Telegram Web after
each message and after the assistant completes if replies disappear during streaming.

1. Ask for an Outlook sign-in link in ordinary language, including when already
   connected. Verify that a fresh link is returned without disconnecting the account.
2. Open it, complete Microsoft sign-in and consent, and verify the success page.
   A preview GET must not consume the ticket. Reused or expired tickets must fail.
3. Ask for the latest three Inbox subjects and senders. Compare against the Inbox
   folder, not a keyword search result.
4. Read seeded calendar entries. Check both dateTime and timeZone. A UTC timestamp
   can fall on the previous date in Pacific time.
5. Reschedule one seeded synthetic appointment and fetch it again by ID. Confirm
   the requested local time, correct UTC conversion, and empty attendee list.
6. Flag one seeded synthetic email and verify its follow-up status.
7. Send a uniquely titled synthetic email to the same test mailbox. Verify the
   exact subject in both Sent Items and Inbox; a successful send response alone
   is insufficient to prove delivery.
8. Check conflicts, create one synthetic appointment, and read it back. If Private
   was requested, verify sensitivity is private, not merely that attendees is empty.
9. Test "tomorrow" near UTC midnight. Resolve the current date in the user's
   timezone before choosing the calendar query bounds. Persist an explicitly
   requested timezone in `ui.userTimezone` and read it back. A memory note or
   `heartbeat.timezone` alone does not configure conversational time grounding.
   Mechanically resolve the local date with `TZ` and `date` before calling the
   calendar skill so the server's UTC date cannot shift the requested day.
10. With operator-authorized hosted interactive auto-approval enabled, start a
    new Telegram chat and repeat Inbox/calendar reads. Verify the gateway reports
    interactive=high while autonomous/headless settings are unchanged. No new raw
    shell approval cards should appear. Existing historical cards are not erased.

## September 2026 live run

Verified through Telegram and independent Microsoft Graph reads:

- Hosted link issuance and Microsoft sign-in completed without disconnecting the
  existing account.
- Seeded Inbox messages were read after correcting an empty-search interpretation.
- A seeded event was moved to 09:00 Pacific and read back as 16:00 UTC.
- A seeded email's follow-up flag was changed and read back as flagged.
- One synthetic message sent only to the test mailbox appeared in Sent Items and
  Inbox.
- A new synthetic appointment was created at 10:00 Pacific with no attendees.
- Its privacy property was corrected and independently verified as private.

The first model responses mishandled UTC display, privacy, and the meaning of
tomorrow near UTC midnight. Treat those as behavioral regression cases, not proof
that every natural-language request succeeds without correction.

## Observed failure modes

- A missing Microsoft origin in CSP form-action blocks the authorization redirect
  after consuming the ticket. Retrying then misleadingly reports an expired link.
- Installing a skill without refreshing skill embeddings and the selection index
  can leave it undiscoverable in an existing assistant.
- An idle lazy CES socket can keep an otherwise completed CLI command alive. The
  calendar wrapper waits for process completion and eventually times out despite
  a successful Graph response. Pending RPCs must remain referenced while idle
  lazy connections must not prevent process exit.
- Empty search results do not establish an empty inbox. UTC event times must not
  be relabelled as local time.

The live checks establish the tested account and scenarios, not universal success
across Microsoft tenant policies, revoked consent, or future service outages.
