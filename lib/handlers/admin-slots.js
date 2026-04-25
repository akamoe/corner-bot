import { Markup } from 'telegraf'
import { getStaffRole } from '../auth.js'
import { adminFlowState } from '../state.js'
import supabase from '../supabase.js'
import { adminKeyboard } from './helpers.js'

export function setupAdminSlots(bot) {
  bot.hears('🕐 Manage Slots', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
    await showSlotsManagement(ctx)
  })

  async function showSlotsManagement(ctx) {
    const { data: slots, error } = await supabase
      .from('pickup_slots')
      .select('*')
      .order('slot_time')

    if (error) return ctx.reply(`❌ ${error.message}`)

    let text = '🕐 *Pickup Slots*\n\n'
    if (!slots?.length) {
      text += '(no slots yet)\n'
    } else {
      text += slots.map(s =>
        `${s.is_active ? '✅' : '❌'} *${s.label}* — max ${s.max_orders}`
      ).join('\n')
    }

    const buttons = (slots || []).map(s => [
      Markup.button.callback(`⚙️ ${s.label}`, `slotmgr_${s.id}`)
    ])
    buttons.push([Markup.button.callback('➕ Add Slot', 'slot_add')])

    await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) })
  }

  bot.action(/^slotmgr_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const id = ctx.match[1]
    const { data: slot } = await supabase.from('pickup_slots').select('*').eq('id', id).maybeSingle()
    if (!slot) return ctx.reply('Slot not found.')

    await ctx.reply(
      `🕐 *${slot.label}*\nTime: ${slot.slot_time}\nMax orders: ${slot.max_orders}\nActive: ${slot.is_active ? 'Yes' : 'No'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(slot.is_active ? '🙈 Deactivate' : '👁 Activate', `slottoggle_${id}`)],
          [Markup.button.callback('✏️ Rename', `slotrename_${id}`)],
          [Markup.button.callback('🔢 Set Max Orders', `slotmax_${id}`)],
          [Markup.button.callback('🗑 Delete', `slotdelete_${id}`)]
        ])
      }
    )
  })

  bot.action(/^slottoggle_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { data: slot } = await supabase.from('pickup_slots').select('is_active').eq('id', id).maybeSingle()
    if (!slot) return ctx.answerCbQuery('Not found.')
    const { error } = await supabase.from('pickup_slots').update({ is_active: !slot.is_active }).eq('id', id)
    if (error) return ctx.answerCbQuery(`Error: ${error.message}`)
    await ctx.answerCbQuery('Updated')
    await ctx.reply(slot.is_active ? '🙈 Slot deactivated.' : '👁 Slot activated.')
  })

  bot.action(/^slotrename_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_slot_rename', slotId: ctx.match[1] })
    await ctx.reply('✏️ Send the new *label* for this slot (e.g. "12:00 PM").', { parse_mode: 'Markdown' })
  })

  bot.action(/^slotmax_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_slot_max', slotId: ctx.match[1] })
    await ctx.reply('🔢 Send the new *max orders* (positive integer).', { parse_mode: 'Markdown' })
  })

  bot.action(/^slotdelete_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { error } = await supabase.from('pickup_slots').delete().eq('id', id)
    if (error) {
      await ctx.answerCbQuery()
      return ctx.reply(`❌ ${error.message}`)
    }
    await ctx.answerCbQuery('Deleted')
    await ctx.reply('🗑 Slot deleted.')
  })

  bot.action('slot_add', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_new_slot_label' })
    await ctx.reply('➕ Send the *label* for the new slot (e.g. "12:00 PM").', { parse_mode: 'Markdown' })
  })
}
