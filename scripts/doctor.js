#!/usr/bin/env node
/**
 * Pre-flight check: is this bot actually able to serve students right now?
 *
 *   npm run doctor
 *
 * Verifies env vars, Telegram reachability, the registered webhook, and that
 * the database answers — plus how much menu/slot content exists (an empty menu
 * means students see "ما في أصناف متاحة").
 */

import 'dotenv/config'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

let problems = 0

const ok = (msg) => console.log(`${GREEN}✅${OFF} ${msg}`)
const warn = (msg) => console.log(`${YELLOW}⚠️ ${OFF} ${msg}`)
const bad = (msg) => {
  problems++
  console.log(`${RED}❌${OFF} ${msg}`)
}

// ─── 1. env ─────────────────────────────────────────────────────

console.log('\n── Environment ─────────────────────────────')
const required = [
  'BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_TELEGRAM_ID',
  'WEBHOOK_SECRET'
]
for (const key of required) {
  if (process.env[key]) ok(`${key} is set`)
  else bad(`${key} is missing`)
}

const baseUrl = process.env.SUPABASE_URL?.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '')
if (baseUrl) {
  if (baseUrl.endsWith('.supabase.co')) ok(`SUPABASE_URL looks sane: ${baseUrl}`)
  else warn(`SUPABASE_URL is unusual: ${baseUrl}`)
}

// ─── 2. Telegram ────────────────────────────────────────────────

console.log('\n── Telegram ────────────────────────────────')
let botUsername = null
if (process.env.BOT_TOKEN) {
  try {
    const me = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`).then((r) => r.json())
    if (me.ok) {
      botUsername = me.result.username
      ok(`bot token valid: @${me.result.username} (${me.result.id})`)
    } else {
      bad(`bot token rejected: ${me.description}`)
    }

    const info = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getWebhookInfo`).then((r) =>
      r.json()
    )
    if (info.ok) {
      if (info.result.url) {
        ok(`webhook: ${info.result.url}`)
        if (info.result.pending_update_count) warn(`${info.result.pending_update_count} pending updates`)
        if (info.result.last_error_message) bad(`webhook error: ${info.result.last_error_message}`)
        const expected = (process.env.WEBHOOK_URL || '').replace(/^https?:\/\//, '')
        if (expected && !info.result.url.includes(expected)) {
          warn(`webhook does not match BOT_TOKEN env pair? (${info.result.url} vs ${process.env.WEBHOOK_URL})`)
        }
      } else {
        warn('no webhook registered (bot only works in polling mode)')
      }
    }
  } catch (err) {
    bad(`could not reach the Telegram API: ${err.message}`)
  }
}

// ─── 3. Database ────────────────────────────────────────────────

console.log('\n── Database ────────────────────────────────')
const TABLES = [
  ['categories', true],
  ['menu_items', true],
  ['toppings', true],
  ['topping_groups', true],
  ['pickup_slots', true],
  ['staff', false],
  ['users', false],
  ['orders', false],
  ['bot_state', false]
]

if (!baseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  warn('skipping database checks (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
} else {
  let dbReachable = false

  for (const [table, contentMatters] of TABLES) {
    try {
      const res = await fetch(`${baseUrl}/rest/v1/${table}?select=*&limit=1`, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          prefer: 'count=exact',
          range: '0-0'
        }
      })

      if (res.status === 200 || res.status === 206) {
        dbReachable = true
        const range = res.headers.get('content-range') || ''
        const total = Number(range.split('/')[1])
        const count = Number.isFinite(total) ? total : '?'
        if (contentMatters && count === 0) warn(`${table}: 0 rows ${DIM}(students will see an empty menu)${OFF}`)
        else if (contentMatters) ok(`${table}: ${count} rows`)
        else console.log(`${DIM}• ${table}: ${count} rows${OFF}`)
      } else if (res.status === 404) {
        bad(`${table}: table not found (PGRST205?) — schema is incomplete`)
      } else {
        const body = await res.text()
        bad(`${table}: HTTP ${res.status} ${body.slice(0, 160)}`)
      }
    } catch (err) {
      bad(`${table}: ${err.cause?.code || err.message} — cannot reach ${baseUrl}`)
      break
    }
  }

  if (!dbReachable) {
    console.log(
      `\n${YELLOW}Hint:${OFF} if this is a DNS error (ENOTFOUND), the Supabase project\n` +
        '       referenced by SUPABASE_URL does not exist any more. Create/restore a\n' +
        '       project and update SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Vercel env too).'
    )
  }
}

// ─── summary ────────────────────────────────────────────────────

console.log('\n── Summary ─────────────────────────────────')
if (problems === 0) {
  console.log(`${GREEN}All checks passed.${OFF}${botUsername ? ` @${botUsername} is good to go 🌽` : ''}`)
} else {
  console.log(`${RED}${problems} problem(s) found — see above.${OFF}`)
  process.exitCode = 1
}
