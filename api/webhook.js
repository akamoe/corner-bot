/**
 * Vercel entry point — Telegram webhook.
 *
 * The bot itself lives in `lib/bot.js`; this file only does HTTP concerns.
 */

import crypto from 'crypto'
import { bot } from '../lib/bot.js'

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Corner Bot is running 🌽' })
  }

  const secret = req.headers['x-telegram-bot-api-secret-token']
  if (!process.env.WEBHOOK_SECRET || !safeEqual(secret, process.env.WEBHOOK_SECRET)) {
    console.warn('[webhook] rejected request with bad secret token')
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let update = req.body
  if (typeof update === 'string') {
    try {
      update = JSON.parse(update)
    } catch (err) {
      console.error('[webhook] malformed body:', err.message)
      return res.status(400).json({ error: 'Bad request' })
    }
  }

  if (!update || typeof update !== 'object') {
    return res.status(400).json({ error: 'Bad request' })
  }

  try {
    await bot.handleUpdate(update)
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[webhook] handleUpdate failed:', err?.stack || err)
    // Telegram retries only on non-2xx; a thrown handler bug would then be
    // retried forever, so acknowledge and let bot.catch report it.
    return res.status(200).json({ ok: false })
  }
}
