# Twilio SMS

Receives signed SMS webhooks through the gateway, persists accepted messages in
a plugin-owned queue, runs the assistant's full conversation with its tools and
history, and submits the reply through Twilio. Webhooks are acknowledged before
inference so model latency does not exceed Twilio's webhook timeout.

Copy this directory to the assistant workspace's `plugins/twilio-sms`. Create
`config.json` there with `accountSid`, `phoneNumber` (E.164), and `enabled`.
Keep it disabled until setup is complete. Store the Twilio Auth Token in the
credential vault as `twilio-sms/auth_token`. Never write it in a config file.

Approve this plugin's incoming-message declaration in channel settings. Configure
the number's incoming-message webhook to POST to the current public ingress URL
plus `/webhooks/plugins/twilio-sms/messages`. The gateway verifies Twilio's
signature and applies its contact admission policy before queueing any message.
Associate the intended sender with a verified contact through the normal channel
verification flow. Do not disable admission checks to test a number.

Only plain text SMS is supported. Carrier registration is a separate requirement:
US long-code A2P registration must be completed before outbound texting works.
A Twilio API acceptance is recorded as `submitted`, not claimed as delivered.
Verify final delivery in Twilio's message logs and on the recipient's phone.

The queue lives in `data/messages.sqlite`. Duplicate incoming MessageSids are
ignored. Interrupted processing, ambiguous sends, busy conversations, and replies
over 1600 characters are marked `review_required`; they are not automatically
resent. A conversation deletion purges its queue records. Restart the assistant
after changing this plugin's config. Quick-tunnel URLs can change after restart;
update the Twilio webhook when the public URL changes.
