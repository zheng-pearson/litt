# Multi-tenant Telegram router

A reference router that fronts many single-tenant Vellum instances with one
shared Telegram bot. See `docs/multi-tenant-telegram-router.md` for the design,
the instance configuration, and the provisioning flow.

**This is a reference, not a product.** The tenant map is read from an
environment variable, there is no persistence, no OAuth, and no retry policy.
A real deployment replaces the map with a database lookup and the gate with a
real authorization check.

## Run

```bash
export BOT_TOKEN='<shared bot token>'
export ROUTER_PORT=8999
export ROUTES='<telegramUserId>=<label>|<instanceGatewayUrl>|<instanceWebhookSecret>'

bun router.ts
```

`ROUTES` is `;`-separated, one entry per tenant:

```
722164045=partner-a|http://127.0.0.1:7830|secret-a;819330021=partner-b|http://127.0.0.1:7831|secret-b
```

Then point the bot's single webhook at the router:

```bash
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=https://<your-public-host>/webhooks/telegram" \
  -d 'allowed_updates=["message","edited_message","callback_query"]'
```

Each instance needs `telegram.webhookManaged: false` so it does not fight the
router for that registration.

## Behaviour

| Sender | Result |
| --- | --- |
| In `ROUTES` | Update forwarded verbatim to that instance with its `x-telegram-bot-api-secret-token` |
| Not in `ROUTES` | Deterministic reply from the router; **no instance is contacted and no model is called** |

The gate is the point: without it, anyone who finds the bot can spend your
inference budget.

## Before using this for real

- Replace the in-memory `ROUTES` map with a lookup keyed on the Telegram user
  id, written when a user completes onboarding.
- Bind identity properly: carry the Telegram user id through your OAuth
  `state` so the callback can associate the verified account with the chat.
- Forward updates to exactly one instance. Update-id dedup is per instance, so
  a fan-out will be processed twice.
- Handle instance startup: a gateway that has not yet loaded Telegram
  credentials returns **503** until it restarts.
