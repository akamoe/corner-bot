#!/usr/bin/env node
/**
 * Register the Telegram webhook + command list.
 *
 *   npm run setup -- --url https://bot.corner.green/api/webhook
 *   npm run setup -- --delete        # remove the webhook (e.g. to use polling)
 *   npm run setup -- --info          # just print the current webhook state
 *
 * Reads BOT_TOKEN / WEBHOOK_SECRET from the environment (.env).
 */

import 'dotenv/config'
import { COMMANDS } from '../lib/bot.js'

const args = process.argv.slice(2)

function argValue(name) {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.split('=').slice(1).join('=')
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 ? args[idx + 1] : undefined
}

const token = process.env.BOT_TOKEN
if (!token) {
  console.error('❌ BOT_TOKEN is not set')
  process.exit(1)
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  }).then((r) => r.json())

async function printInfo() {
  const info = await api('getWebhookInfo')
  const me = await api('getMe')
  console.log('🤖 Bot:', me.result?.username, `(${me.result?.id})`)
  console.log('🔗 Webhook:', info.result?.url || '(none — polling mode)')
  console.log('📥 Pending updates:', info.result?.pending_update_count ?? 0)
  if (info.result?.last_error_message) {
    console.log('⚠️ Last error:', info.result.last_error_message)
  }
}

const deleteWebhook = args.includes('--delete')
const infoOnly = args.includes('--info')
const url = argValue('url') || process.env.WEBHOOK_URL

if (infoOnly) {
  await printInfo()
} else if (deleteWebhook) {
  const res = await api('deleteWebhook', { drop_pending_updates: false })
  console.log(res.ok ? '🧹 Webhook removed.' : `❌ ${res.description}`)
  await printInfo()
} else if (!url) {
  console.error('❌ Pass the webhook URL: npm run setup -- --url https://your-domain/api/webhook')
  process.exit(1)
} else {
  const secret = process.env.WEBHOOK_SECRET
  if (!secret) {
    console.error('❌ WEBHOOK_SECRET is not set — refusing to register an unprotected webhook.')
    process.exit(1)
  }

  const res = await api('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query']
  })
  console.log(res.ok ? `✅ Webhook registered -> ${url}` : `❌ ${res.description}`)

  const commands = await api('setMyCommands', { commands: COMMANDS })
  console.log(commands.ok ? '✅ Command list updated.' : `❌ ${commands.description}`)

  await printInfo()
}
