import { Markup } from 'telegraf'
import { getStaffRole } from './auth.js'
import { adminFlowState } from './state.js'
import supabase from './supabase.js'

export function setupAdminCommands(bot) {
  bot.command('addcashier', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
    adminFlowState.set(ctx.from.id, { step: 'awaiting_cashier_id' })
    await ctx.reply(
      '👤 *Add Cashier*\n\n' +
      'Step 1 of 2: Please send the cashier\'s *Telegram ID* (numeric).\n\n' +
      '💡 Tip: Ask them to message @userinfobot to get their ID.',
      { parse_mode: 'Markdown' }
    )
  })

  bot.command('removecashier', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
    adminFlowState.set(ctx.from.id, { step: 'awaiting_remove_id' })
    await ctx.reply(
      '🗑 *Remove Cashier*\n\nSend the cashier\'s *Telegram ID* to remove.',
      { parse_mode: 'Markdown' }
    )
  })

  bot.command('add_category', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
    adminFlowState.set(ctx.from.id, { step: 'awaiting_new_category_name' })
    await ctx.reply('➕ Send the *name* of the new category (you can prefix with an emoji e.g. "🍕 Pizza").', { parse_mode: 'Markdown' })
  })

  bot.command('add_item', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

    const { data: cats } = await supabase.from('categories').select('*').order('sort_order')
    if (!cats?.length) return ctx.reply('No categories exist. Add a category first.')

    const buttons = cats.map(c => [Markup.button.callback(`${c.emoji || '🍴'} ${c.name}`, `addtocat_${c.id}`)])
    await ctx.reply('Which category should the new item go in?', Markup.inlineKeyboard(buttons))
  })

  bot.command('add_topping', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
    adminFlowState.set(ctx.from.id, { step: 'awaiting_topping_name' })
    await ctx.reply('🧀 Send the *name* of the new topping.', { parse_mode: 'Markdown' })
  })

  bot.command('add_group', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
    adminFlowState.set(ctx.from.id, { step: 'awaiting_group_name' })
    await ctx.reply(
      '📦 Send the *name* of the new topping group.\n\n' +
      'Next you will choose:\n• selection_type: single / multiple\n• required: yes / no',
      { parse_mode: 'Markdown' }
    )
  })

  bot.command('assign_group_to_item', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

    const { data: items } = await supabase.from('menu_items').select('id, name').eq('is_available', true).order('name')
    if (!items?.length) return ctx.reply('No items available.')

    const buttons = items.map(i => [Markup.button.callback(i.name, `assigngrp_item_${i.id}`)])
    await ctx.reply('Select an item to assign a group to:', Markup.inlineKeyboard(buttons))
  })

  bot.command('assign_topping_to_group', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

    const { data: groups } = await supabase.from('topping_groups').select('id, name').order('name')
    if (!groups?.length) return ctx.reply('No topping groups exist.')

    const buttons = groups.map(g => [Markup.button.callback(g.name, `assignt_group_${g.id}`)])
    await ctx.reply('Select a group:', Markup.inlineKeyboard(buttons))
  })
}
