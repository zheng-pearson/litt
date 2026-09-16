# Fronting many assistants with one Telegram bot

Vellum is single-tenant per process: one running instance serves exactly one
guardian. Serving many people means running many instances. Telegram, meanwhile,
binds **one webhook URL per bot token** and offers no API to create bots
programmatically — so "one bot per user" is not reachable at scale.

The way out is an external router that owns the bot and dispatches each update
to the instance that owns that sender.

```
Telegram ──► router (owns bot token, owns the one webhook URL)
                │
                ├─ unknown sender ──► deterministic reply, no instance touched
                │
                └─ known sender ───► POST /webhooks/telegram on that user's gateway
                                          │
                                          └─► instance replies via Telegram
                                              sendMessage using the shared token
```

Outbound needs no routing: Telegram's send API is stateless, so each instance
calls it directly with the shared token and users see one consistent bot.

## Why the gate matters

Unknown senders must be answered by the router itself, never forwarded. A bot
reachable by anyone is an open door to your inference budget; the gate is the
only thing between a stranger and a model call.

## Configuring the instances

Each instance must stop managing the bot's webhook, because the registration is
now the router's:

```jsonc
{
  "telegram": { "webhookManaged": false }
}
```

**Do not use `ingress.enabled: false` for this.** That setting means "do not
accept webhooks at all" and actively calls `deleteWebhook`. On a shared bot
token, one instance booting would deregister the router and take delivery down
for every user. `telegram.webhookManaged: false` instead means "someone else
owns it": the reconciler neither registers nor deregisters, `/webhooks/telegram`
keeps serving forwarded updates, and the webhook health sweep skips instead of
reporting a permanent false alarm.

Each instance also needs the shared bot token and its own webhook secret, which
the router presents when forwarding:

```bash
assistant credentials set --service telegram --field bot_token      <shared-token>
assistant credentials set --service telegram --field webhook_secret <per-instance-secret>
```

The secret is only auto-generated when none exists, so provisioning a known
value up front is supported and lets the router know it without a read-back.

## Provisioning a new user

No desktop app and no interactive verification code are required.

1. **Hatch** the instance with a known `GUARDIAN_BOOTSTRAP_SECRET`.
2. **Mint the guardian** — `POST /v1/guardian/init` with
   `x-bootstrap-secret: <secret>`, which returns the guardian principal and an
   access token. Each secret is single-use; `POST /v1/guardian/reset-bootstrap`
   re-arms it.
3. **Set credentials** — the shared bot token and this instance's webhook
   secret, plus the model provider key.
4. **Pre-bind the channel** — `POST /v1/contacts/guardian/channel` with
   `{"type":"telegram","address":"<telegram user id>","externalUserId":"<telegram user id>","status":"active"}`.
   This writes the binding as already-verified
   (`verified_via: platform_auto_register`), so the user's first message
   resolves as guardian with no code exchange.
5. **Add the route** to the router's sender → instance map.

### Order matters

`telegramReady` is evaluated at gateway boot. Credentials written to an
already-running instance do not flip it, and the instance will reject forwarded
updates with **HTTP 503** until it restarts. Provision credentials *before* the
instance takes traffic, or restart after writing them.

### Latency

A cold hatch takes tens of seconds to bring up the runtime, gateway, and
credential service. Either pre-warm a pool of blank instances and claim one on
demand, or make onboarding explicitly asynchronous.

## Known constraints

- **Shared rate limit.** Telegram rate-limits per bot token, so every user
  shares one budget while retry and backoff are per instance. Fine at low
  hundreds of users; a real ceiling eventually.
- **Dedup is per instance.** Update-id deduplication lives in each instance, so
  the router must deliver each update to exactly one instance. Fanning one
  update out to two will not be caught.
- **`setMyCommands` is global.** Every instance writes the same payload to the
  shared bot on credential change. Idempotent, but it is a global mutation.
- **Group chats.** The guardian pre-binding sets `deliveryChatId` equal to
  `externalUserId`, which holds for private chats (user id == chat id) but not
  for groups.

## Not what the managed platform does

Vellum's own managed runtime gives each assistant its own bot and its own
callback URL, and each pod registers its own webhook. The shared-bot pattern
here is different, so the sender → instance map is yours to own and persist —
nothing in this repo provides it. `gateway/src/routing/resolve-assistant.ts` is
explicit that a gateway process fronts exactly one daemon.

A runnable reference router lives in `examples/multi-tenant-telegram-router/`.
