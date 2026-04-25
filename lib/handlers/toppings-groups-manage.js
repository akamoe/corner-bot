import { Markup } from 'telegraf'
import { getStaffRole } from '../auth.js'
import { adminFlowState } from '../state.js'
import supabase from '../supabase.js'

export function setupToppingsGroupsManage(bot) {
  // ─── MANAGE TOPPINGS ────────────────────────────────────────

  bot.action('toppings_manage', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()

    const { data: toppings, error } = await supabase
      .from('toppings').select('id, name, price, is_active').order('name')
    if (error) return ctx.reply(`❌ ${error.message}`)
    if (!toppings?.length) return ctx.reply('No toppings yet. Add one first.')

    const buttons = toppings.map(t => [
      Markup.button.callback(`${t.is_active ? '✅' : '❌'} ${t.name} — ${Number(t.price).toFixed(2)} IQD`, `toppin_${t.id}`)
    ])
    buttons.push([Markup.button.callback('⬅️ Back', 'menu_back')])
    await ctx.reply('🧀 *Toppings*\n\nSelect a topping to edit:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) })
  })

  bot.action(/^toppin_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const id = ctx.match[1]

    const { data: t } = await supabase.from('toppings').select('*').eq('id', id).maybeSingle()
    if (!t) return ctx.reply('Topping not found.')

    await ctx.reply(
      `🧀 *${t.name}*\n` +
      `💰 Price: ${Number(t.price).toFixed(2)} IQD\n` +
      `🏷 Tag: ${t.tag || '(none)'}\n` +
      `${t.is_active ? '✅ Active' : '❌ Hidden'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Rename', `tpname_${id}`)],
          [Markup.button.callback('💲 Edit Price', `tpprice_${id}`)],
          [Markup.button.callback('🏷 Edit Tag', `tptag_${id}`)],
          [Markup.button.callback(t.is_active ? '🙈 Deactivate' : '👁 Activate', `tptoggle_${id}`)],
          [Markup.button.callback('🗑 Delete', `tpdel_${id}`)],
          [Markup.button.callback('⬅️ Back', 'toppings_manage')]
        ])
      }
    )
  })

  bot.action(/^tpname_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_topping_new_name', toppingId: ctx.match[1] })
    await ctx.reply('✏️ Send the new *name* for this topping.', { parse_mode: 'Markdown' })
  })

  bot.action(/^tpprice_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_topping_new_price', toppingId: ctx.match[1] })
    await ctx.reply('💲 Send the new *price* (0 if free).', { parse_mode: 'Markdown' })
  })

  bot.action(/^tptag_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_topping_new_tag', toppingId: ctx.match[1] })
    await ctx.reply('🏷 Send the new *tag* (or "-" to remove).', { parse_mode: 'Markdown' })
  })

  bot.action(/^tptoggle_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { data: t } = await supabase.from('toppings').select('is_active').eq('id', id).maybeSingle()
    if (!t) return ctx.answerCbQuery('Not found.')
    const { error } = await supabase.from('toppings').update({ is_active: !t.is_active }).eq('id', id)
    if (error) return ctx.answerCbQuery(`Error: ${error.message}`)
    await ctx.answerCbQuery(t.is_active ? 'Deactivated' : 'Activated')
    await ctx.reply(t.is_active ? '🙈 Topping deactivated.' : '👁 Topping activated.')
  })

  bot.action(/^tpdel_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { error } = await supabase.from('toppings').delete().eq('id', id)
    if (error) {
      await ctx.answerCbQuery()
      return ctx.reply(`❌ ${error.message}\n(Remove this topping from all groups first.)`)
    }
    await ctx.answerCbQuery('Deleted')
    await ctx.reply('🗑 Topping deleted.')
  })

  // ─── MANAGE GROUPS ────────────────────────────────────────────

  bot.action('groups_manage', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()

    const { data: groups, error } = await supabase
      .from('topping_groups').select('id, name, selection_type, required').order('name')
    if (error) return ctx.reply(`❌ ${error.message}`)
    if (!groups?.length) return ctx.reply('No topping groups yet. Add one first.')

    const buttons = groups.map(g => [
      Markup.button.callback(
        `${g.required ? '🔴' : '🟢'} ${g.name} [${g.selection_type}]`,
        `grpmgr_${g.id}`
      )
    ])
    buttons.push([Markup.button.callback('⬅️ Back', 'menu_back')])
    await ctx.reply('📦 *Topping Groups*\n\nSelect a group to edit:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) })
  })

  bot.action(/^grpmgr_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const id = ctx.match[1]

    const { data: g } = await supabase.from('topping_groups').select('*').eq('id', id).maybeSingle()
    if (!g) return ctx.reply('Group not found.')

    await ctx.reply(
      `📦 *${g.name}*\n` +
      `Type: ${g.selection_type}\n` +
      `Required: ${g.required ? 'Yes 🔴' : 'No 🟢'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Rename', `grpname_${id}`)],
          [Markup.button.callback(`🔄 Change Type (${g.selection_type})`, `grptype_${id}`)],
          [Markup.button.callback(g.required ? '🟢 Make Optional' : '🔴 Make Required', `grpreq_${id}`)],
          [Markup.button.callback('🗑 Delete', `grpdel_${id}`)],
          [Markup.button.callback('⬅️ Back', 'groups_manage')]
        ])
      }
    )
  })

  bot.action(/^grpname_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_group_new_name', groupId: ctx.match[1] })
    await ctx.reply('✏️ Send the new *name* for this group.', { parse_mode: 'Markdown' })
  })

  bot.action(/^grptype_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const id = ctx.match[1]
    const { data: g } = await supabase.from('topping_groups').select('selection_type').eq('id', id).maybeSingle()
    if (!g) return ctx.reply('Not found.')
    const newType = g.selection_type === 'single' ? 'multiple' : 'single'
    const { error } = await supabase.from('topping_groups').update({ selection_type: newType }).eq('id', id)
    if (error) return ctx.reply(`❌ ${error.message}`)
    await ctx.reply(`✅ Type changed to *${newType}*.`, { parse_mode: 'Markdown' })
  })

  bot.action(/^grpreq_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { data: g } = await supabase.from('topping_groups').select('required').eq('id', id).maybeSingle()
    if (!g) return ctx.answerCbQuery('Not found.')
    const { error } = await supabase.from('topping_groups').update({ required: !g.required }).eq('id', id)
    if (error) return ctx.answerCbQuery(`Error: ${error.message}`)
    await ctx.answerCbQuery(g.required ? 'Now optional' : 'Now required')
    await ctx.reply(g.required ? '🟢 Group is now *optional*.' : '🔴 Group is now *required*.', { parse_mode: 'Markdown' })
  })

  bot.action(/^grpdel_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { error } = await supabase.from('topping_groups').delete().eq('id', id)
    if (error) {
      await ctx.answerCbQuery()
      return ctx.reply(`❌ ${error.message}\n(Remove this group from all items first.)`)
    }
    await ctx.answerCbQuery('Deleted')
    await ctx.reply('🗑 Group deleted.')
  })
}
