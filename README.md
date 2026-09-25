# Corner Bot 🌽

Telegram bot for the Corner corn restaurant (campus, Iraq). Telegraf on Vercel
serverless, talking to the shared Supabase project the web app also uses.

- Bot: [@corner_rest_bot](https://t.me/corner_rest_bot) — webhook `https://bot.corneriq.site/api/webhook`
- One bot, three roles: **student**, **cashier**, **admin** (resolved from `staff` / `ADMIN_TELEGRAM_ID`)

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local webhook server on `:3000` (point a tunnel at it) |
| `npm run dev:poll` | Long polling — no tunnel needed. Removes the production webhook; restores it on Ctrl+C if `PROD_WEBHOOK_URL` is set |
| `npm test` | Unit + end-to-end flow tests (in-memory DB + fake Bot API, no network) |
| `npm run check` | `node --check` every file |
| `npm run doctor` | Pre-flight: env, Telegram, webhook, DB reachability, content sanity |
| `npm run setup -- --url https://…/api/webhook` | Register the webhook + command list (also `--info`, `--delete`) |

## Environment

Copy `.env.example` → `.env` and fill in:

```
BOT_TOKEN=                 # from @BotFather
SUPABASE_URL=              # https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY= # server-side key; the anon key is RLS-limited and will fail
ADMIN_TELEGRAM_ID=         # numeric Telegram id of the owner
WEBHOOK_SECRET=            # must match the secret_token registered with Telegram
```

Optional: `RESTAURANT_TIMEZONE` (default `Asia/Baghdad`), `PORT`, `WEBHOOK_URL`, `PROD_WEBHOOK_URL`.
Set both webhook URL variables to `https://bot.corneriq.site/api/webhook` when using the setup script or local polling.

## Wayl checkout

The customer selects a pickup time and then chooses cash or a Wayl payment link.
The bot confirms an electronic order only after a signed Wayl callback and a
server-side Wayl status check. The browser return page does not confirm payment.

Set these values in the **bot's own** server environment:

```
WAYL_API_KEY=             # Wayl merchant key; do not use the website's runtime environment
WAYL_WEBHOOK_SECRET=      # unique bot secret, at least 32 characters
WAYL_ENV=test             # keep test until the full checkout is verified
WAYL_SITE_URL=https://bot.corneriq.site
CRON_SECRET=              # protects /api/wayl-reconcile
```

Wayl sends callbacks to `https://bot.corneriq.site/api/wayl`. The return page is
`https://bot.corneriq.site/api/wayl-return`. The cleanup route runs daily under
Vercel Cron and also needs `CRON_SECRET`. Missing Wayl values hide the electronic
payment option and reject Wayl callbacks. Test mode never confirms an order or
notifies the kitchen. Do not change `WAYL_ENV` to `live` before a separate
end-to-end test and deployment review.

The shared database migration and rollback are in `supabase/migrations` and
`docs/wayl`. The rollback stops if any Telegram payment row exists. See
`docs/wayl/review.md` for the production impact, tests, and buying journey audit.

## How it works

- **State** lives in the `bot_state` table (one jsonb row per Telegram user) —
  serverless containers are wiped between requests, so nothing is kept in memory.
- **Orders**: a cart is an `orders` row with `status = 'pending'`; confirming it
  mints a unique `ORD-XXXXX` code and notifies cashiers.
- **Slots** are daily recurring (`pickup_slots.slot_time`). Past and full slots
  are hidden, and capacity is re-checked at booking time so a slot can't be oversold.
- **Money and dates** always go through `lib/money.js` and `lib/time.js`
  (Vercel runs in UTC; the restaurant is UTC+3).

## Tests

`test/unit.test.js` covers formatting, order codes, timezone maths and callback
limits. `test/flows.test.js` drives the real bot through Telegraf against
`test/support/fake-supabase.js` (PostgREST-shaped in-memory DB) and
`test/support/fake-telegram-api.js` (local Bot API), so student/cashier/admin
flows are verified without touching production.
