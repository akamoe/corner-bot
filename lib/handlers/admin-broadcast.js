import { Markup } from 'telegraf'
import { getStaffRole } from '../auth.js'
import { adminFlowState } from '../state.js'
import supabase from '../supabase.js'
import { adminKeyboard } from './helpers.js'

export function setupAdminBroadcast(bot) {
  bot.hears('📢 Broadcast', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_broadcast_message' })
    await ctx.reply(
      '📢 *Broadcast*\n\nSend the message you want to send to *all users*.\n\nReply with /cancel to abort.',
      { parse_mode: 'Markdown' }
    )
  })

  bot.action('broadcast_confirm', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()

    const state = await adminFlowState.get(ctx.from.id)
    if (!state || state.step !== 'awaiting_broadcast_confirm') {
      return ctx.reply('⚠️ Nothing to broadcast. Tap 📢 Broadcast again.')
    }

    const message = state.message
    await adminFlowState.delete(ctx.from.id)

    const { data: users, error } = await supabase
      .from('users')
      .select('telegram_id')
      .not('telegram_id', 'is', null)

    if (error) return ctx.reply(`❌ ${error.message}`)
    if (!users?.length) return ctx.reply('📭 No users to notify.')

    await ctx.reply(`📡 Sending to ${users.length} user(s)...`)

    // Send concurrently with a concurrency limit to avoid rate limiting
    const CONCURRENCY = 20
    const results = { sent: 0, failed: 0 }
    
    for (let i = 0; i < users.length; i += CONCURRENCY) {
      const batch = users.slice(i, i + CONCURRENCY)
      const outcomes = await Promise.allSettled(
        batch.map(u => 
          bot.telegram.sendMessage(u.telegram_id, `📢 *Announcement*\n\n${message}`, { parse_mode: 'Markdown' })
            .catch(() => { results.failed++; return null })
        )
      )
      results.sent += outcomes.filter(o => o.status === 'fulfilled' && o.value !== null).length
    }

    await ctx.reply(`✅ Broadcast complete.\n\n📬 Sent: ${results.sent}\n⚠️ Failed: ${results.failed}`)
  })

  bot.action('broadcast_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled')
    await adminFlowState.delete(ctx.from.id)
    await ctx.reply('❌ Broadcast cancelled.')
  })
}
