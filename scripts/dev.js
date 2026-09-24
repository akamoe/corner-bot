#!/usr/bin/env node
/**
 * Local development for the Corner bot.
 *
 *   npm run dev            -> local HTTP webhook on http://localhost:3000/api/webhook
 *                             (point a tunnel at it, then `npm run setup -- --url <tunnel>`)
 *   npm run dev:poll       -> long polling, no tunnel needed
 *
 * Polling and a registered webhook are mutually exclusive in Telegram, so
 * `--poll` removes the webhook first and restores it on exit when
 * PROD_WEBHOOK_URL is set.
 */

import 'dotenv/config'
import http from 'http'
import { bot } from '../lib/bot.js'

const usePolling = process.argv.includes('--poll')
const port = Number(process.env.PORT || 3000)

function assertEnv() {
  const required = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
  const missing = required.filter((key) => !process.env[key])
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}`)
    console.error('   Copy .env.example to .env and fill it in.')
    process.exit(1)
  }
}

async function startPolling() {
  await bot.telegram.deleteWebhook({ drop_pending_updates: false })
  console.log('🧹 Removed the production webhook so polling can receive updates.')

  process.on('SIGINT', async () => {
    console.log('\n👋 Stopping polling...')
    if (process.env.PROD_WEBHOOK_URL && process.env.WEBHOOK_SECRET) {
      await bot.telegram
        .setWebhook(process.env.PROD_WEBHOOK_URL, { secret_token: process.env.WEBHOOK_SECRET })
        .then(() => console.log(`🔁 Restored webhook -> ${process.env.PROD_WEBHOOK_URL}`))
        .catch((err) => console.error('⚠️ Could not restore the webhook:', err.message))
    } else {
      console.warn('⚠️ PROD_WEBHOOK_URL is not set — remember to restore the webhook!')
    }
    process.exit(0)
  })

  await bot.launch()
  console.log('🌽 Bot is polling. Send it a message in Telegram. Ctrl+C to stop.')
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/webhook')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ status: 'Corner Bot dev server 🌽' }))
    }

    const chunks = []
    for await (const chunk of req) chunks.push(chunk)

    let update
    try {
      update = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (err) {
      console.error('[dev] bad JSON body:', err.message)
      res.writeHead(400)
      return res.end('bad request')
    }

    try {
      await bot.handleUpdate(update)
    } catch (err) {
      console.error('[dev] handler error:', err?.stack || err)
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })

  server.listen(port, () => {
    console.log(`🌽 Dev webhook listening on http://localhost:${port}/api/webhook`)
    console.log('   Expose it with a tunnel, then run:')
    console.log(`   npm run setup -- --url https://<your-tunnel>/api/webhook`)
  })
}

assertEnv()

if (usePolling) {
  await startPolling()
} else {
  startServer()
}
