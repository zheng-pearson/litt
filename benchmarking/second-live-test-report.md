# Second live test report

Session: September 17, 2026, Pacific time. Test account uses synthetic mailbox
and calendar data. No email was sent and no calendar event was changed in this
session. Personal account identifiers and authorization links are omitted.

## Verified

- New Telegram bot accepts `/start` and responds under the Second identity.
- A request for inbox and calendar data with no active connection reports the
  missing connection instead of inventing empty results.
- A follow-up in ordinary language produces a clickable Microsoft sign-in link.
  No developer credentials, slash command, or separate settings screen required.
- Opening that fresh link, selecting the test Microsoft account, and using its
  existing consent reaches the application's “Connection completed” page.
- After returning to chat, Second reads three actual inbox subjects and senders.
  All three match the Outlook inbox visible in the browser.
- The September 17 calendar response contains the synthetic board-preparation
  event at 9:00-9:30 AM Pacific and deal-review event at 10:00-10:30 AM Pacific.
  These match Outlook's 16:00 and 17:00 UTC entries. Prior-evening events are not
  incorrectly included in the Pacific-day result.
- Telegram Web still requires refreshes to reliably display replies.

## Incomplete or failed acceptance criteria

- The initial missing-connection answer did not proactively include a sign-in
  link. The tester had to explicitly request it.
- The callback did not visibly resume the original request on its own. The
  tester returned to Telegram and prompted the read again.
- The combined inbox/calendar read took roughly a minute. Precise latency was
  not instrumented; this is an observed chat-timestamp estimate, not an SLA.
- Proactive setup was requested in ordinary language. Second reports enabled
  briefings at 7 AM and 6 PM Pacific, hourly mail/calendar monitors, and urgent
  mail/calendar monitors every 15 minutes. Its first response explicitly said
  the monitors were awaiting their first poll. These are reported configuration
  results, not independent proof of successful polls or deliveries.
- A two-minute, one-off reminder was requested to exercise scheduled delivery
  separately from an ordinary chat response. No reminder arrived after the
  scheduled time. Second first reported no delivery record, then corrected its
  diagnosis to an internal-channel delivery with no Telegram attempt. Its
  reported routing metadata selected Telegram but used single-channel routing.
  Local source inspection confirms that urgency prepends the internal channel
  and the cap ignores routing hints. The local fix carries routing hints into
  the cap and honors the first connected preferred channel. Live deployment
  and scheduled delivery remain unverified.
- Urgent-only alerts, unchanged-item suppression, daily briefing deduplication,
  adaptive briefing times, cancellation handling, and quiet hours remain unproven.
- Gmail, Google Calendar, WhatsApp, Mini App onboarding, and calendar-write
  round trips are not verified by this session.

The successful Outlook reads prove this account's live mail/calendar access,
not completion of the full integration or proactivity objective.

## Google read follow-up, September 17

- The operator approved and applied the production queue constraint expansion
  for `oauth_resume`. The console reported zero changed rows, the constraint was
  read back, and read-only mode was restored. Automatic continuation is enabled
  in production; its browser-consent-to-Telegram acceptance test remains pending.

- Before API enablement, Gmail returned HTTP 403 with `SERVICE_DISABLED` and
  `accessNotConfigured`. The CLI also appended missing provider-default scopes,
  which did not establish that the requested read lacked permission.
- After the operator enabled Gmail and Calendar APIs, the existing connection
  successfully listed Gmail messages and primary-calendar events. No new grant
  was needed for those reads.
- The request handler no longer appends optional provider-default scope warnings
  to successful requests. Google API-disabled errors explicitly identify operator
  configuration and do not recommend reconnecting.
- The live Telegram test returned a latest-email subject and sender and reported
  no events for September 17. No email or calendar writes were requested.
- The request-handler suite passed 60 tests; the hosted-demo suite passed 66.
  Assistant fast type-check passed. Callback-driven automatic task resumption
  remains unverified; this test resumed the read with a Telegram message.
- Snapshot `second-20260917-google-r10` reached active status and production's
  snapshot setting points to it. The production router deployment completed and
  its health endpoint returned success. The current test assistant also received
  the request-handler patch, verified byte-for-byte and by a warning-free read.

## Local verification

- Routing intent suite: 18 passed, including four new regression cases.
- Decision engine suite: 31 passed.
- Notification pipeline failure suite: 5 passed when run independently.
- Scheduler recurrence suite: 13 passed.
- Assistant fast type-check and `git diff --check` passed.
- Running the scheduler and pipeline suites together leaks module mocks and
  fails five pipeline tests; the isolated pipeline run passes all five.
- Second reports modifying the existing briefing instructions to explicitly
  target Telegram without changing their times. That workaround is not a
  verified successful scheduled delivery.
- Deployment requires updating the assistant snapshot, not merely Vercel.
  The earlier snapshot publishing attempt returned HTTP 403. No new snapshot
  containing this routing fix has been published.

## September 17 default-destination verification

- The current assistant was emitting low-urgency heartbeat notifications only
  into its internal inbox. Telegram delivery was available but not selected.
- Added an opt-in default destination for assistant-authored notifications,
  preserving explicit preferences and legacy defaults on other installations.
- Applied the patch to the test assistant, restarted successfully, and set
  `notifications.defaultChannels` to Telegram. Set user and heartbeat timezones
  to `America/Los_Angeles` at the user's request.
- An immediate background notification reached Telegram and was visibly
  verified in the chat. The delivery audit records Telegram success.
- A one-time script schedule independently sent a second notification through
  the same pipeline. Its run completed successfully, Telegram acknowledged the
  send, the chat displayed it, and the schedule disabled itself after its only run.
  Existing user schedules were preserved. This tests scheduled delivery, not
  the quality of an autonomous model-generated briefing.
- Decision engine: 34 tests passed. Routing intent: 18 passed. Pipeline failure:
  5 passed. Transport retry policy: 19 passed. Hosted demo: 77 passed.
  Both assistant and hosted-demo type-checks passed.
- Snapshot `second-20260917-proactive-r11` is active and the production router
  deployment is ready with this snapshot configured for new signups.
- A forced heartbeat completed successfully and delivered its own generated
  update to Telegram, verified in both the audit and the visible chat. Its claim
  that Outlook remained expired conflicts with the preceding successful calendar
  response. Delivery is verified; heartbeat freshness needs a separate diagnosis.
