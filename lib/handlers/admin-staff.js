import { Markup } from 'telegraf'
import { getStaffRole } from '../auth.js'
import { adminFlowState } from '../state.js'
import supabase from '../supabase.js'
import { adminKeyboard } from './helpers.js'

export function setupAdminStaff(bot) {
  bot.hears('👤 Manage Staff', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

    await ctx.reply(
      '👤 *Staff Management*\n\nChoose an action:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Add Cashier', 'add_cashier_btn')],
          [Markup.button.callback('🗑 Remove Cashier', 'remove_cashier_btn')],
          [Markup.button.callback('📋 List Cashiers', 'list_cashiers_btn')]
        ])
      }
    )
  })

  bot.action('add_cashier_btn', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_cashier_id' })
    await ctx.reply(
      '👤 *Add Cashier*\n\n' +
      "Step 1 of 2: Please send the cashier's *Telegram ID* (numeric).\n\n" +
      '💡 Tip: Ask them to message @userinfobot to get their ID.',
      { parse_mode: 'Markdown' }
    )
  })

  bot.action('remove_cashier_btn', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_remove_id' })
    await ctx.reply(
      "🗑 *Remove Cashier*\n\nSend the cashier's *Telegram ID* to remove.",
      { parse_mode: 'Markdown' }
    )
  })

  bot.action('list_cashiers_btn', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()

    const { data: cashiers, error } = await supabase
      .from('staff')
      .select('*')
      .eq('role', 'cashier')
      .eq('is_active', true)

    if (error) return ctx.reply(`❌ ${error.message}`)
    if (!cashiers?.length) return ctx.reply('📭 No cashiers yet.')

    const lines = cashiers.map(c => `• @${c.telegram_username || '(no username)'} — \`${c.telegram_id}\``).join('\n')
    await ctx.reply(`📋 *Active Cashiers*\n\n${lines}`, { parse_mode: 'Markdown' })
  })
}
