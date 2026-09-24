# Corner Bot 🌽

Telegram bot for the Corner corn restaurant (campus, Iraq). Telegraf on Vercel
serverless, talking to the shared Supabase project the web app also uses.

- Bot: [@corner_rest_bot](https://t.me/corner_rest_bot) — webhook `https://bot.corner.green/api/webhook`
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

Optional: `RESTAURANT_TIMEZONE` (default `Asia/Baghdad`), `PORT`, `PROD_WEBHOOK_URL`.

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
