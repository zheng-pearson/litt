# Second improvement acceptance

Completion requires deployed behavior observed in Telegram. Local tests and
instruction text establish implementation evidence only.

## Current checkpoint after repository transition

The nine-item goal remains incomplete. The chronological entries below retain
their original observations; later entries supersede earlier deployment status.

Acceptance summary: 1 of 9 verified, 8 partial. Implementation or deployment
alone does not close an item.

### Gmail live retest, September 17, 14:18-14:20 Pacific

The user explicitly approved temporary Gmail disconnect/reconnect. Second
confirmed Gmail disconnected and Outlook/Pearson unchanged. The exact question
"Have you connected Gmail?" at 14:19:43 received a progress preview observed
7.6 seconds later, then only "No. Gmail is currently disconnected." The final
reply contained no link. Requirement 3 therefore still fails in the live chat;
installed skill instructions are not sufficient evidence of the behavior.

An explicit reconnect request at 14:20:15 produced a secure Gmail link and
promised an automatic read-only Inbox check after consent. The browser reached
Google's account chooser with Gmail read-only scope. User consent is pending;
Gmail remains disconnected until that succeeds. No email/draft/calendar write
was requested. Receipt and resumption acceptance remain unproven for this flow.

### Gmail routing regressions after rollout

Deployment `dpl_Ap2yoQ5BHGx1ri8HvWbzrToqpbjD` promoted the narrowed setup
opt-out wording from `9d71dcfa90`, preserving the Pearson identity instructions
and partner-format exception. Only connections.ts and hosted-skills.ts changed
against the SHA-verified live baseline. Its health check passed.

The exact question at 14:25:54 still failed: Second answered from history,
provided no link, and said completed research was running. Runtime diagnostics
subsequently confirmed the message reached the assistant at 14:26:18 after
gateway setup delay; the quick responder then chose a direct answer.

After a routing repair was reported healthy at 14:30:26, the same question at
14:30:49 produced a progress acknowledgement observed after 13.5 seconds. Its
first substantive response, observed after 78.3 seconds without refreshing,
contained a Google authorization link, but the callback was localhost and the
scopes included modification, sending, Drive and contacts. This is a failed
hosted-flow test, not successful proactive setup. The user was warned not to use
that link. No consent was granted through it. Repair and retest remain required.

Isolated recovery regression coverage verifies that overlapping workers cannot
send the same unexpired leased receipt twice, and a rejected send retains its
encrypted queued payload without logging successful delivery. A subsequent
accepted retry logs once, clears the payload, and is not sent again on another
drain. The 12 scoped worker-recovery tests and hosted-router typecheck pass.
This does not prove exactly-once delivery after an ambiguous network response,
lease expiry during a send, or a crash after Telegram acceptance before the
database completion write. Those boundaries remain open.

| Item | Status | Outstanding evidence |
| --- | --- | --- |
| 1. Responsiveness and queueing | Partial | Consistent acknowledgement and useful-progress timing, including interruptions. |
| 2. Canonical Outlook state | Partial | Interactive and background checks agree under refresh and scope failures. |
| 3. Proactive Gmail setup | Partial | First-reply link while disconnected; temporary disconnect needs user approval. |
| 4. OAuth resumption | Partial | Outlook passed; equivalent Gmail continuation remains untested. |
| 5. Duplicate and stale suppression | Partial | Controlled live suppression and retry evidence. |
| 6. Safe external communication | Partial | Remove unsupported draft claims and independently verify no external send. |
| 7. Six-section legal briefs | Verified | Repeated live briefs and correction preserved all six sections; retain regression coverage. |
| 8. Plain-language recovery | Partial | Expired Outlook link passed; temporary and API-disabled failures remain untested. |
| 9. Immediate connection receipt | Partial | Outlook delivered; exact latency and Gmail parity remain unverified. |

Pearson released its live test window to the partner task while awaiting user
consent. The partner task is implementing and testing responses to new messages
during ongoing Telegram work. This acceptance task keeps the shared chat clear
and must independently assess the resulting timing and safety evidence.

- Receipt timing was promoted as `dpl_C8fPM6BHxDSBh8cmcwqgPNWeWLna` after a
  staging health check and a second live-baseline check. Only worker.ts and
  store.ts differed from the deployed Pearson baseline. The older statement
  below that timing is not promoted is historical, not current status.
- Outlook receipt and automatic continuation were delivered in Telegram without
  a new prompt. Exact callback-to-receipt timing and equivalent Gmail behavior
  remain unverified.
- The later trace inspection found successful Outlook-related tool calls,
  including two skill executions, in the 13:34 turn. The sanitized evidence
  does not identify their exact read targets or independently prove both reads.
- Canonical background/interactive state, deliberately stale live delivery,
  consistent latency, and disconnected Gmail setup still require acceptance.
- Legal briefs repeatedly contain all six sections, and approval attribution
  improved. The Cedar draft's unsupported claim of work underway remains a
  failure. A draft labeled unsent is not itself an outbound-mail audit.
- Gmail remains connected; the requested temporary disconnect/reconnect test
  has not been approved. No model/effort change has been approved or made here.

Work resumed from fork commit `1f3fa92c4e` on a separate acceptance worktree.
The 44 credential-health tests passed after the repository transition. Pearson
owns the next live Telegram window, followed by the partner task's overlap and
latency tests. This task sends no live prompts or shared deployments during
those windows. Their evidence must be reviewed against this goal's criteria,
not treated as completion solely because another task reports success.

Router follow-up: deployment `dpl_69ZRvhyEdPN3wjktRFqRrkNz6eQv` passed its
health check and was promoted on September 17. Callback ticket consumption and
receipt/continuation jobs commit atomically; rollback and expiry regressions are
covered by the 80 passing router tests. The upstream token exchange is still a
separate transaction, so a crash between exchange and queue commit remains an
unverified recovery case. The connection skill's short discovery description
explicitly says to include a secure link, not merely offer one. Behavioral
acceptance of that description change remains unverified.

Runtime follow-up deployed at 12:40:56 Pacific on September 17: background credential pings classify
HTTP 403 as unverified access, not revoked consent. Credential-alert producers
recheck the exact account through the credential-health service after composing
the notification and before initial dispatch, suppressing changed evidence.
Pipeline tests cover suppression, retry-safe recheck failure, and dedupe claims;
health tests cover Outlook 403 with/without refresh and account-specific checks.
This does not yet cover stale transport retries or unify interactive status.

Runtime rollout evidence: the connection ticket resolved the Telegram test to one
canonical tenant. Source inspection found an unrelated existing notification
change, which was preserved by applying only the health-specific patch hunks.
The initial rollout restored its backups after a premature readiness failure;
independent inspection then confirmed original hashes and HTTP 200 on both
health paths. Deployment `dpl_2Ne3qvakVYopi9FdUz6YssVfrXLY` reapplied the
preflighted patch, drained and restarted the existing assistant, and observed
HTTP 503, 503, then 200 during bounded readiness checks. Original source backups
remain in the sandbox. No workspace, connection, or conversation was replaced.

Post-upgrade Telegram check: at 12:41:22, requested a current Gmail read without
email contents. Second replied at 12:41 that live authentication and the Inbox
read succeeded. This verifies delivered post-restart behavior and preserved
connection usability as reported by the assistant, not an independent API trace
or second-level completion timing.

| Requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Acknowledge under 5 seconds; useful progress within 15-20 seconds | Unchanged connection skills skip index rebuilds. Independent tenants can progress while provisioning runs. | Instrument receipt, acknowledgement and useful output; test slow reads and interruptions in Telegram. |
| Canonical Outlook state | Deployed health checks use the shared refresh retry on unexpected 401, distinguish 403 from revoked consent, and recheck the exact account. Live heartbeat guidance was installed and read back. | Verify consistent interactive and background state after successful consent, including refresh and scope failures. |
| Immediate Gmail setup link | Hosted skill covers status questions and installs without Microsoft configuration. | Observe an unconnected Gmail question produce a link in its first reply. |
| OAuth task resumption | Callback queues the original conversation with a stable event ID and server-generated link-request timestamp; local replay and timestamp propagation tests pass. | Complete browser consent and observe verified read plus original task result without a new message, despite intervening unrelated topics. |
| Duplicate/stale notifications | Deployed producer checks run before each channel adapter send. Tests cover changed evidence, recheck failures and dedupe-claim handling. | Verify actual suppression and recovery under delayed turns and concurrent background checks; inspect adapter-internal retries. |
| External communication | Existing consent event explicitly does not authorize external writes. | Exercise unsettled facts, missing recipient, revised scope and safe drafts; verify no external send. |
| Legal review packet | Live Acme packet and two subsequent Birch briefs include all six sections. The Birch correction removed the retracted departure date and preserved matter and approval boundaries. | Recheck structure during subsequent recovery and latency testing to guard against regressions. |
| Plain-language recovery | The expired-link request at 13:24 produced a replacement Outlook link in its first reply, with automatic verification and appointment-time continuation explained. | Exercise API-disabled errors and temporary failures in Telegram. |
| Immediate connection receipt | Schema and router deployed. Durable callback notice bypasses busy assistant work; callback replay, denial, provider and schema tests pass. | Measure successful callback-to-Telegram delivery after browser consent. |

The initial live report does not establish exact backend latency or queue root
cause. Telegram refreshes and observation intervals confound timing. The
15-minute board-packet reminder was not observed through its due time, so its
delivery remains unverified. A separate delivery-check message was observed but
its trigger was not controlled by this test.

Deployment: production deployment `dpl_AgHUc5kftXHGXK9C4Qv1287KLAwR`
completed its opt-in database migration using Vercel's existing secret bindings
and was promoted to `litt-demo.vercel.app` on September 17, 2026. The production
health endpoint returned HTTP 200. Webhook logs for the live checks below name
this deployment. No production secret was copied into the repository.

Post-deployment Telegram observations (Pacific time):
- 12:21:54: "Have you connected Outlook?" received a disconnected-status answer
  without a link at 12:22. Earlier in the chat the user had explicitly
  disconnected Outlook, so this is not a clean first-time setup-intent test.
- 12:22:15: asking for status and next step produced "I can send a fresh secure
  Microsoft sign-in link" but did not supply one. Proactive setup is not proven.
- The chat now visibly shows the board reminder delivered at 12:09. This
  corrects the earlier observation gap, but does not establish second-level timing.
- 12:24:23: a concrete next-appointment request after saying Outlook was needed
  again produced a secure reconnect link in the first reply at 12:24, with a
  promise to check the appointment after consent. Browser consent remains pending.

Deployment `dpl_FWw6ynJsZAURRMR3ULnUEttNGWag` was health-checked and promoted
at approximately 12:26 Pacific. It acknowledges newly persisted active Telegram text messages
with a typing action independently of assistant work. Duplicate update IDs do not
repeat it; acknowledgement failure does not discard work. This is a receipt
indicator, not useful task progress. Production logs for the two synthetic packet
messages record Telegram accepting the typing action in 536 ms and 459 ms after
webhook handling began. This excludes client-to-webhook transit and does not
prove that a user saw the indicator or received useful output within 20 seconds.
Validation: 78 scoped router tests pass; TypeScript checking passes.

The packet prompt was inadvertently sent twice after Telegram's refreshed tree
omitted the first pending message. Two resulting outputs must not be classified
as spontaneous duplicate notifications. Verify transmission before refreshing
and avoid re-sending based solely on a temporarily incomplete UI tree.

The delivered Acme packet was opened in Telegram and inspected. It includes
Confirmed facts, Unknowns requiring confirmation, Assumptions (none), Decision
options for board discussion, Approval required, and Action status. It attributes
facts to the user's founder-discussion notes, invents no grant terms, distinguishes
negotiation authority from final approval, and states no client communication was
sent and no retention terms approved. Original source notes were separately
attached. This proves this output's structure, not universal compliance or an
independent mailbox audit of absence of external sends.

### Connection routing retest, September 17, 12:54 Pacific

The 12:45 status-only question still returned a disconnected answer without a
link after updating the original skill description. Inspection of memory v2
shows pinned skill cards are deduplicated by slug for the conversation until
compaction, so updating the file does not guarantee a fresh card in an existing
chat. This is a likely cause, not a captured prompt trace.

Deployment `dpl_B8XMw8vS1hmqw9jkNpuFb7oYZmXE` adds a distinct pinned routing
card that points to the current connection skill rather than duplicating its
implementation. It passed 80 router tests (304 assertions), type-checking and
the staged health endpoint before promotion. The inspection utility also reads
the actual message fields (contentBlocks and toolCalls) and requests the latest
page, avoiding false-negative evidence from an absent content field.

At 12:54:43, sent "Have you connected Outlook?" once in Telegram. At the first
observation approximately eight seconds later, Telegram displayed "I'm checking
Outlook's live connection status again." This is progress text, not proof of
an actual read or a successful first-answer setup link.

At the next fully loaded observation, about 31 seconds after sending, the final
reply included a clickable Reconnect Outlook link without another user command.
The message stated Outlook was disconnected and live authentication failed, and
explained Microsoft sign-in and the ten-minute expiry. This proves first-turn
link delivery for this Outlook test, not Gmail parity, a 20-second completion
bound, or successful OAuth resumption. The link was not followed or approved.

### Additional freshness guard

The notification broadcaster rechecks producer evidence immediately before each
adapter send, including deferred sends. If evidence changes between channels,
remaining sends are suppressed. The emit pipeline skips its home-feed projection
for stale evidence and releases the dedupe claim only if nothing was sent or
remains in flight. Recheck errors fail closed and permit retry in that same
undelivered case. Adapter-internal transport retries still require validation.
Validation: 29 broadcaster tests and ten pipeline tests pass separately, and
core type-checking passes. The suites run in separate processes because the
pipeline suite's broadcaster mock contaminates combined runs.

Deployment `dpl_Hfxxq2vdz8X1g6KyShQpNoCAbCPx` applied the notification delta to
the same resolved Second tenant on September 17. Build logs show patch preflight
success, restart and health 503, 503, then 200 at 13:00:10 Pacific. This maintenance
deployment was not promoted over the existing router. The patch keeps separate
source backups and preserves the earlier credential-health update. Runtime
application is verified by the maintenance result; a deliberately stale live
notification has not yet been exercised in Telegram.

Post-restart Telegram test at 13:00:59 supplied a correction: departure was only
suspected, the board had discussed retention but approved neither a grant nor
negotiation authority, and the client recipient was unknown. It explicitly
prohibited sends and mailbox drafts. No response was visible at the 20-second
observation. By approximately 31 seconds the final answer preserved all corrected
facts, framed the next decision as fact gathering rather than approving terms,
and declined client follow-up because the recipient was unidentified. It stated
nothing was drafted or sent. This supports safe handling and correction recall,
but it omitted explicit unknowns, assumptions and decision alternatives from the
requested brief. Six-section consistency remains incomplete. The statement that
nothing was sent is not an independent outbound audit.

### Follow-up, September 17, 13:04 Pacific

Read-only inspection independently matched the live broadcaster and emit-signal
SHA-256 hashes to the local freshness implementation and verified both health
endpoints. Message-list timestamps cannot establish response latency here:
the assistant rows use their creation time when a sent timestamp is absent.
Do not interpret the near-identical user/assistant row times as fast delivery.

Deployment `dpl_9W3rdW9PENVynkorDHR7qHW3X7Hf` passed staging health and was
promoted. Its installer checks the three independent hosted skills concurrently
instead of serially, while retaining the index rebuild after completed writes.
The legal workflow requires all six sections for updated briefs as well as
packets, and requests usable inline content before optional file preparation.
Router validation: 80 tests, 306 assertions and type-checking pass. Latency and
brief consistency must still be measured after this deployment.

The user agreed to complete Outlook consent. At 13:04:17, requested the next
Outlook appointment time with explicit read-only scope and automatic continuation.
Second returned a fresh sign-in link and promised to resume without another
message. Consent completion and the automatic receipt/result remain pending.

Source investigation found that BYO health pings returned HTTP 401 as an object,
bypassing withValidToken's throw-on-401 refresh/retry contract used by interactive
requests. A local fix raises the expected status-bearing error and classifies a
final 401 only after the shared retry. A regression for a future-expiry Outlook
token that receives 401 then recovers passes; all 44 credential-health tests pass.
This additional refresh fix is not deployed yet.

At 13:08, deployment `dpl_Cp2VuFzLsdKrkAGUHMyTdYLxdxKi` verified that the
unexpected-401 delta applies cleanly to Second's live source. It was a read-only
preflight, with no source change or restart while consent was pending.

Read-only inspection at 13:09 found the last eight Telegram jobs done on their
first attempts, including the 13:04 calendar request, and no newer OAuth jobs in
that window. The configured balanced profile is openai/gpt-5.6-luna with high
effort; this is configuration evidence, not a trace of the effective model for
every turn. No model or effort setting was changed. The live heartbeat checklist
did not contain the fresh connection guidance.

Deployment `dpl_5L2nbKiTuwsKhYABHrTsz4t5RnkV` appended that guidance to the
existing checklist and verified the readback at 13:11:26 Pacific. It preserved a
uniquely named source backup, did not change the schedule, and did not restart
Second. Tests cover preservation, repeat-run idempotence and refusal to overwrite
an intervening edit. Combined router and checklist tests: 82 pass, 314 assertions.
This verifies installed instructions, not a live heartbeat suppression scenario.

### Refresh retry and response-length conflict

Deployment `dpl_HNHfp5nN28LicFemzE99VgRrTFvu` applied the unexpected-401
health retry delta with a separate source backup. The runtime returned HTTP 200
at 13:14:50 Pacific after its controlled restart. Staging router health also
passed, and this deployment was promoted.

The source SOUL template contained absolute two-sentence messaging and
three-sentence response caps, conflicting with the six-section brief workflow.
Those two paragraphs were replaced with one concise-by-default instruction that
preserves required substance and structure. The hosted installer replaces only
the exact old block in the template and live SOUL, preserving other edits.
This is removal of a conflicting global constraint, not additional legal
workflow text in the system prompt. Router/checklist tests: 82 pass, 316 asserts.
At 13:15:47, requested an inline Acme decision brief while explicitly keeping the
pending Outlook calendar request separate. Behavioral verification is pending.

That retest still returned only two sentences and omitted the six-section brief.
No output was visible at approximately 19 seconds; the final reply was visible
by 30 seconds. Inspection at 13:16:58 confirmed the live SOUL has neither old cap
and does have the new brevity rule; the updated legal skill file is also present.
The response made no tool calls. Thus deployment succeeded but behavior did not;
the evidence does not establish that the model read the updated legal workflow.
All 22 core system-prompt tests pass after the template change.

Deployment `dpl_58T7zS3yMWMoi1eYpDZmuJxzm7Ro` passed staging health and was
promoted. It installs a distinct legal-review v2 discovery card with the required
six sections stated directly in its description, preserving historical v1 files.
At 13:19:39 a fresh synthetic Birch matter was sent to test both structure and
separation from Acme, while leaving the Outlook request pending consent.

The Birch reply included all six labeled sections, attributed the notice to the
founder, identified missing evidence, offered three options, preserved approval
boundaries and stated nothing was sent or drafted. No output was visible at the
20-second observation; it was visible by about 31 seconds after a refresh.

At 13:20:31, corrected Birch's notice to an unconfirmed possibility with no date.
The updated brief again included all six sections as a readable list, removed
the departure date, kept Birch separate from Acme, and explicitly separated
discussion, negotiation authority and approval of retention terms. All proposed
actions remained unapproved. This warm-turn response was absent at the 15-second
observation and visible by 24.5 seconds; browser reload timing prevents a strict
20-second latency conclusion. These two live outputs support section consistency
and correction handling. They do not independently audit outbound mailbox state.

### Original-task context across OAuth

Deployment `dpl_5RzZWQob9gPyX7nH4upSZ2DroxL2` passed staging health and was
promoted. New conversational links persist a server-generated request timestamp
through the encrypted connect ticket, callback ticket and continuation job. The
continuation identifies the mail/calendar task pending at that point rather than
a newer unrelated topic, and explicitly honors later cancellation or revision.
Older tickets/jobs without this optional field retain their prior fallback.
Tests cover timestamp creation, rejection of a caller-supplied timestamp,
propagation across the provider redirect and callback, replay protection, and
legacy continuation retries. Router tests: 81 pass, 317 assertions; type-checking
passes. Live resumption still requires successful browser consent.

At 13:24:17 requested a replacement for the expired Outlook link, retaining the
read-only next-appointment task and asking for automatic verification afterward.

At 13:28 a refreshed Telegram view showed the replacement link in Second's
13:24 reply, alongside a promise to verify calendar access and report only the
next appointment time. Intervening user messages about Pearson had also received
responses. The replacement page opened successfully and was left for the user
to complete Microsoft consent. It requests mail/calendar management and sending
permissions, broader than this read-only test; the user was explicitly informed.
No consent success, callback receipt or resumed calendar result is established
by opening that page. The delayed UI observation cannot establish reply latency.

Current regression rerun: 83 router/checklist tests pass with 325 assertions.
This confirms the current local test state, not live OAuth completion. Model and
reasoning-effort settings remain unchanged pending the user's comparison choice.

Independent core reruns also pass: 44 credential-health tests, 29 broadcaster
tests and 10 emit-pipeline tests (229 assertions combined). These suites run in
separate processes to avoid module-mock contamination.

Transport inspection identifies a remaining duplicate-risk boundary:
`notifications/adapters/telegram.ts` catches every rich approval-send error and
starts a plain-text send. A timeout or ambiguous failure is not proof that the
first send was rejected. The underlying Telegram API also uses retryableCall;
the producer freshness callback currently stops at the broadcaster boundary.
Neither transport-level uncertainty nor retry-time freshness is established by
the passing broadcaster tests. A fix must preserve definitively rejected rich
message fallback and account for partial multi-chunk delivery, rather than
blindly treating every error as safe to resend.

### Successful live OAuth continuation and fallback hardening

The refreshed Telegram conversation shows a Microsoft sign-in receipt at 13:28
and the automatic result at 13:29: no upcoming Outlook appointments in the next
30 days. There was no intervening user prompt after consent. The pending calendar
task resumed rather than the newer Pearson discussion. This proves delivered
receipt and automatic task continuation for this Outlook case. Minute-resolution
chat timestamps do not prove immediate callback latency, and the reported read
still needs independent tool-trace verification.

The notification adapter permits its plain-text fallback only for a definite
Telegram rejection. Ambiguous errors propagate without starting a second copy.
The send helper wraps failures after acknowledged chunks so they cannot be
misclassified as safe whole-message fallback. Scoped tests pass: 14 notification
adapter tests and 42 Telegram send tests; core type-checking and diff checks pass.
This does not eliminate lower-level retry ambiguity or add retry-time freshness.
Deployment `dpl_HGTWWFKsB5mecZ7SGKf3YtroB6Bz` verified the delta applies to the
live runtime without changing it. Application is pending the maintenance result.

Maintenance deployment `dpl_6ntKsYAZQB8MwZeNhfC4aJfhubxa` applied the fallback
delta to the same scoped runtime and retained separate source backups. After a
controlled restart, readiness returned 503, 503, then 200 at 13:33:23 Pacific.
The maintenance deployment is not promoted over the existing router. This is
runtime application evidence; no deliberate ambiguous live send was induced.

### Post-consent Outlook retest

At 13:34:19, sent one confirmed Telegram message requesting fresh Inbox and
calendar reads, with no content disclosure or writes. At 9.6 seconds, the live
UI displayed progress explaining that both services were being checked with
read-only calls. After refresh, the final reply stated both reads succeeded,
without another connection link or expired-state claim. This establishes a
successful post-restart interactive check as reported in Telegram and progress
inside 20 seconds for this run. It does not establish exact final latency,
independent API results, or subsequent heartbeat agreement.

The initial composer interaction did not populate or submit the message; the
empty composer was visually verified before retrying. Only the second,
confirmed outgoing message is included in timing or queue evidence.

Permission to temporarily disconnect and reconnect Gmail was requested to test
the actual disconnected-state first reply. No Gmail connection was changed.

### Retry-time freshness implementation

The local notification broadcaster forwards its producer evidence guard to the
Telegram adapter. The adapter passes a before-attempt callback through every
plain-text chunk into the shared API retry loop. It runs after backoff and before
fetch; rejection escapes the retry catch, so changed evidence or an unavailable
recheck cannot trigger another network attempt or plain-text fallback.
Other callers retain the optional-hook default behavior.

Validation: 63 shared-retry/Telegram-send tests, 15 notification-adapter tests and
29 broadcaster tests pass. Tests exercise evidence changing after a retry delay,
callback forwarding for multiple chunks, and adapter suppression. This delta is
not deployed yet. Existing partial-delivery accounting and ambiguous transport
failures remain separate limitations; these tests do not prove exactly-once
delivery or a controlled live stale-notification scenario.

Deployment `dpl_3rJrGKrCgjSwCTvxpXCbY77ixof6` applied this retry-time delta to
Second's scoped runtime. Preflight passed against the live files; separate source
backups were retained. Controlled restart readiness returned 503, 503, then 200
at 13:38:22 Pacific. This maintenance deployment does not replace the promoted
router. Live stale-notification behavior remains unverified; installation and
readiness are not substitutes for that scenario.

### Ambiguous authority retest

At 13:38:58, asked for a Birch client update for review and a decision brief,
providing only a founder's report that the board was "fine with equity" and
explicitly missing records, terms, cap table and recipient. The delivered reply
contained all six sections, denied that informal sentiment established negotiation
authority, and labeled the draft review-only with nothing sent or mailbox-drafted.
The final answer was visible at 23.3 seconds after a refresh; no reliable sub-20
second final timing is established.

The draft nevertheless asserted board discussion, absence of approval and active
fact gathering more firmly than the supplied evidence warranted. This is a
remaining drafting-safety failure, not a full pass. Local hosted legal guidance
distinguishes unverified approval from confirmed non-approval and requires source
attribution and conditional language inside drafts. That revision is not yet
deployed or behaviorally verified. Concurrent Pearson connector changes appeared
in the shared hosted source and must be preserved during any scoped deployment.

Maintenance deployment `dpl_DP2NMX6MayRdmYrdvydndCZK9Wnn` installed only the
legal-review v3 skill, refreshed discovery and verified its content at 13:41:29.
It did not restart the assistant or promote a router containing concurrent
Pearson work. The v3 discovery description includes the attribution/uncertainty
rule so the existing conversation receives a fresh card. All 81 router tests
pass after updating the expected skill identity; TypeScript checking passes.
A fresh Cedar matter was sent at 13:42:03 for behavioral verification.

The Cedar response was visible at 20.3 seconds after a refresh. It preserved the
founder's attribution in the draft, called formal approval unverified rather
than absent, marked the recipient TBD and the update unsent, and included all
six brief sections. This corrects the tested approval-status overstatement.
However, the draft still said "We are confirming the governance and equity
details" without evidence that work had started, despite the installed guidance.
The remaining active-work claim is a drafting accuracy failure; the full legal
drafting requirement is not marked complete. The observation timing does not
prove the strict 20-second target.

### Independent post-consent inspection

Read-only deployment `dpl_54N43ZHDuqiAoZDfwZLvFWHDhCMg` inspected the scoped
runtime at 13:43:44. Both OAuth jobs were created at 13:28:35.260 and finished
on their first attempt. The six recent Telegram jobs also finished in one
attempt. No completion timestamp is stored, so this does not measure receipt
latency. Both runtime health endpoints returned 200; the heartbeat guidance and
updated brevity rule remain present. The configured profile remains high effort.

Attempts to call the local-only OAuth status/request routes through the hosted
gateway returned route-level 403 without a provider response. This is an
inspection access boundary, not evidence of revoked Outlook consent. Do not
count these as failed Microsoft reads or bypass the route policy. Independent
provider-read verification needs an authorized local diagnostic path or a
verified assistant tool trace. Telegram's earlier success wording alone remains
insufficient to prove canonical state across background checks.

### Receipt timing instrumentation

The local worker logs send duration and queue-creation-to-accepted-receipt
duration only after the channel send resolves successfully. Logs contain the
provider, channel, attempt and durations, not chat identity, message text or
credentials. Legacy jobs without a parseable creation timestamp report null
rather than fabricated timing. This measures queue-to-send acceptance, not
browser callback start, user-visible rendering or the subsequent verified read.
All 82 router tests (320 assertions), type-checking and diff checks pass.
The instrumentation is not promoted: the shared router also contains concurrent
Pearson connection changes outside this improvement rollout.
