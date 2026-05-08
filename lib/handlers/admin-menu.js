import { Markup } from 'telegraf'
import { getStaffRole } from '../auth.js'
import { adminFlowState } from '../state.js'
import supabase from '../supabase.js'

export function setupAdminMenu(bot) {
  // ─── MAIN MENU ENTRY ────────────────────────────────────────

  bot.hears('🍽 Manage Menu', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
    await showMenuManagement(ctx)
  })

  async function showMenuManagement(ctx) {
    await ctx.reply(
      '🍽 *Menu Management*\n\nChoose an action:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📖 View / Edit Menu', 'menu_view')],
          [Markup.button.callback('➕ Add Item', 'menu_add_item')],
          [Markup.button.callback('➕ Add Category', 'menu_add_category')],
          [Markup.button.callback('🧀 Add Topping', 'menu_add_topping'), Markup.button.callback('🗂 Manage Toppings', 'toppings_manage')],
          [Markup.button.callback('📦 Add Topping Group', 'menu_add_group'), Markup.button.callback('⚙️ Manage Groups', 'groups_manage')],
          [Markup.button.callback('🔗 Assign Group → Item', 'menu_assign_group')],
          [Markup.button.callback('🔗 Assign Topping → Group', 'menu_assign_topping')]
        ])
      }
    )
  }

  // ─── CATEGORY / ITEM VIEW ────────────────────────────────────

  bot.action('menu_view', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()

    const { data: cats, error } = await supabase
      .from('categories')
      .select('*')
      .order('sort_order')

    if (error) return ctx.reply(`❌ Error: ${error.message}`)
    if (!cats?.length) return ctx.reply('No categories yet. Add one first.')

    const buttons = cats.map(c => [
      Markup.button.callback(`${c.emoji || '🍴'} ${c.name}${c.is_active ? '' : ' (hidden)'}`, `menucat_${c.id}`)
    ])
    buttons.push([Markup.button.callback('⬅️ Back', 'menu_back')])

    await ctx.reply('📂 *Categories*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) })
  })

  bot.action('menu_back', async (ctx) => {
    await ctx.answerCbQuery()
    await showMenuManagement(ctx)
  })

  bot.action(/^menucat_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const catId = ctx.match[1]

    const { data: cat } = await supabase.from('categories').select('*').eq('id', catId).maybeSingle()
    if (!cat) return ctx.reply('Category not found.')

    const { data: items } = await supabase
      .from('menu_items')
      .select('*')
      .eq('category_id', catId)
      .order('sort_order')

    const buttons = (items || []).map(i => [
      Markup.button.callback(`${i.is_available ? '✅' : '❌'} ${i.name} — ${Number(i.price).toFixed(0)} IQD`, `menuitem_${i.id}`)
    ])
    buttons.push([Markup.button.callback('✏️ Rename Category', `catrename_${catId}`)])
    buttons.push([Markup.button.callback('🗑 Delete Category', `catdelete_${catId}`)])
    buttons.push([Markup.button.callback('⬅️ Back', 'menu_view')])

    await ctx.reply(
      `${cat.emoji || '🍴'} *${cat.name}*\n\n${items?.length ? 'Pick an item to edit:' : '(no items in this category)'}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    )
  })

  // ─── ITEM ACTIONS ────────────────────────────────────────────

  bot.action(/^menuitem_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const id = ctx.match[1]
    const { data: item } = await supabase.from('menu_items').select('*').eq('id', id).maybeSingle()
    if (!item) return ctx.reply('Item not found.')

    await ctx.reply(
      `*${item.name}*\n${item.description || ''}\n\n💰 ${Number(item.price).toFixed(2)} IQD\n${item.is_available ? '✅ Available' : '❌ Hidden'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Edit Name', `itemedit_name_${id}`)],
          [Markup.button.callback('💲 Edit Price', `itemedit_price_${id}`)],
          [Markup.button.callback(item.is_available ? '🙈 Hide' : '👁 Show', `itemtoggle_${id}`)],
          [Markup.button.callback('🗑 Delete Item', `itemdelete_${id}`)]
        ])
      }
    )
  })

  bot.action(/^itemedit_name_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_item_name', itemId: ctx.match[1] })
    await ctx.reply('✏️ Send the new *name* for this item.', { parse_mode: 'Markdown' })
  })

  bot.action(/^itemedit_price_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_item_price', itemId: ctx.match[1] })
    await ctx.reply('💲 Send the new *price* (numbers only).', { parse_mode: 'Markdown' })
  })

  bot.action(/^itemtoggle_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { data: item } = await supabase.from('menu_items').select('is_available').eq('id', id).maybeSingle()
    if (!item) return ctx.answerCbQuery('Not found.')
    const { error } = await supabase.from('menu_items').update({ is_available: !item.is_available }).eq('id', id)
    if (error) return ctx.answerCbQuery(`Error: ${error.message}`)
    await ctx.answerCbQuery(item.is_available ? 'Hidden' : 'Shown')
    await ctx.reply(item.is_available ? '🙈 Item hidden.' : '👁 Item shown.')
  })

  bot.action(/^itemdelete_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { error } = await supabase.from('menu_items').delete().eq('id', id)
    if (error) {
      await ctx.answerCbQuery()
      return ctx.reply(`❌ ${error.message}`)
    }
    await ctx.answerCbQuery('Deleted')
    await ctx.reply('🗑 Item deleted.')
  })

  // ─── CATEGORY ACTIONS ────────────────────────────────────────

  bot.action(/^catrename_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_category_rename', categoryId: ctx.match[1] })
    await ctx.reply('✏️ Send the new *name* for this category.', { parse_mode: 'Markdown' })
  })

  bot.action(/^catdelete_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    const id = ctx.match[1]
    const { error } = await supabase.from('categories').delete().eq('id', id)
    if (error) {
      await ctx.answerCbQuery()
      return ctx.reply(`❌ ${error.message}\n(You may need to delete the items inside first.)`)
    }
    await ctx.answerCbQuery('Deleted')
    await ctx.reply('🗑 Category deleted.')
  })

  // ─── ADD CATEGORY / ITEM ─────────────────────────────────────

  bot.action('menu_add_category', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_new_category_name' })
    await ctx.reply('➕ Send the *name* of the new category (you can prefix with an emoji e.g. "🍕 Pizza").', { parse_mode: 'Markdown' })
  })

  bot.action('menu_add_item', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()

    const { data: cats } = await supabase.from('categories').select('*').order('sort_order')
    if (!cats?.length) return ctx.reply('No categories exist. Add a category first.')

    const buttons = cats.map(c => [Markup.button.callback(`${c.emoji || '🍴'} ${c.name}`, `addtocat_${c.id}`)])
    await ctx.reply('Which category should the new item go in?', Markup.inlineKeyboard(buttons))
  })

  bot.action(/^addtocat_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_new_item_name', categoryId: ctx.match[1] })
    await ctx.reply('➕ Send the *name* of the new item.', { parse_mode: 'Markdown' })
  })

  // ─── TOPPING / GROUP / ASSIGNMENT ────────────────────────────

  bot.action('menu_add_topping', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_topping_name' })
    await ctx.reply('🧀 Send the *name* of the new topping.', { parse_mode: 'Markdown' })
  })

  bot.action('menu_add_group', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_group_name' })
    await ctx.reply('📦 Send the *name* of the new topping group.', { parse_mode: 'Markdown' })
  })

  // ─── ASSIGN GROUP TO ITEM ────────────────────────────────────

  bot.action('menu_assign_group', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()

    const { data: items } = await supabase.from('menu_items').select('id, name').eq('is_available', true).order('name')
    if (!items?.length) return ctx.reply('No items available.')

    const buttons = items.map(i => [Markup.button.callback(i.name, `assigngrp_item_${i.id}`)])
    await ctx.reply('Select an item to assign a group to:', Markup.inlineKeyboard(buttons))
  })

  bot.action(/^assigngrp_item_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const itemId = ctx.match[1]

    const { data: groups } = await supabase.from('topping_groups').select('id, name').order('name')
    if (!groups?.length) return ctx.reply('No topping groups exist. Create one first.')

    await adminFlowState.set(ctx.from.id, { step: 'selecting_group_for_item', itemId })

    const buttons = groups.map(g => [Markup.button.callback(g.name, `pick_grp_${g.id}`)])
    await ctx.reply('Select a group to assign:', Markup.inlineKeyboard(buttons))
  })

  bot.action(/^pick_grp_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const groupId = ctx.match[1]

    const state = await adminFlowState.get(ctx.from.id)
    if (!state || state.step !== 'selecting_group_for_item') {
      return ctx.reply('⚠️ Session expired. Please tap 🔗 Assign Group → Item again.')
    }

    const { itemId } = state
    await adminFlowState.delete(ctx.from.id)

    try {
      const { data: existing } = await supabase
        .from('item_topping_groups')
        .select('id')
        .eq('menu_item_id', itemId)
        .eq('group_id', groupId)
        .maybeSingle()

      if (existing) {
        return ctx.reply('⚠️ This group is already assigned to that item.')
      }

      const [{ data: item }, { data: group }] = await Promise.all([
        supabase.from('menu_items').select('name').eq('id', itemId).maybeSingle(),
        supabase.from('topping_groups').select('name').eq('id', groupId).maybeSingle()
      ])

      const { error } = await supabase
        .from('item_topping_groups')
        .insert({ menu_item_id: itemId, group_id: groupId })

      if (error) {
        console.error('[adminMenu] pick_grp_ insert error itemId:', itemId, 'groupId:', groupId, error.message, error)
        return ctx.reply(`❌ Failed to assign group: ${error.message}`)
      }

      await ctx.reply(
        `✅ Group *"${group?.name || groupId}"* assigned to item *"${item?.name || itemId}"* successfully!`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('[adminMenu] pick_grp_ unexpected error itemId:', itemId, 'groupId:', groupId, err.message, err)
      await ctx.reply('❌ An unexpected error occurred. Please try again.')
    }
  })

  // ─── ASSIGN TOPPING TO GROUP ─────────────────────────────────

  bot.action('menu_assign_topping', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()

    const { data: groups } = await supabase.from('topping_groups').select('id, name').order('name')
    if (!groups?.length) return ctx.reply('No topping groups exist.')

    const buttons = groups.map(g => [Markup.button.callback(g.name, `assignt_group_${g.id}`)])
    await ctx.reply('Select a group:', Markup.inlineKeyboard(buttons))
  })

  bot.action(/^assignt_group_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const groupId = ctx.match[1]

    const { data: toppings } = await supabase.from('toppings').select('id, name').eq('is_active', true).order('name')
    if (!toppings?.length) return ctx.reply('No toppings available.')

    await adminFlowState.set(ctx.from.id, { step: 'selecting_topping_for_group', groupId })

    const buttons = toppings.map(t => [Markup.button.callback(t.name, `pick_top_${t.id}`)])
    await ctx.reply('Select a topping to add to this group:', Markup.inlineKeyboard(buttons))
  })

  bot.action(/^pick_top_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const toppingId = ctx.match[1]

    const state = await adminFlowState.get(ctx.from.id)
    if (!state || state.step !== 'selecting_topping_for_group') {
      return ctx.reply('⚠️ Session expired. Please tap 🔗 Assign Topping → Group again.')
    }

    const { groupId } = state
    await adminFlowState.delete(ctx.from.id)

    try {
      const { data: existing } = await supabase
        .from('topping_group_options')
        .select('id')
        .eq('group_id', groupId)
        .eq('topping_id', toppingId)
        .maybeSingle()

      if (existing) {
        return ctx.reply('⚠️ This topping is already in that group.')
      }

      const [{ data: group }, { data: topping }] = await Promise.all([
        supabase.from('topping_groups').select('name').eq('id', groupId).maybeSingle(),
        supabase.from('toppings').select('name').eq('id', toppingId).maybeSingle()
      ])

      const { error } = await supabase
        .from('topping_group_options')
        .insert({ group_id: groupId, topping_id: toppingId })

      if (error) {
        console.error('[adminMenu] pick_top_ insert error groupId:', groupId, 'toppingId:', toppingId, error.message, error)
        return ctx.reply(`❌ Failed to assign topping: ${error.message}`)
      }

      await ctx.reply(
        `✅ Topping *"${topping?.name || toppingId}"* added to group *"${group?.name || groupId}"* successfully!`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('[adminMenu] pick_top_ unexpected error groupId:', groupId, 'toppingId:', toppingId, err.message, err)
      await ctx.reply('❌ An unexpected error occurred. Please try again.')
    }
  })

  // ─── LEGACY assignt_top_ handler ──────────────────────────────

  bot.action(/^assignt_top_(.+)_(.+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const [, groupId, toppingId] = ctx.match

    try {
      const { data: existing } = await supabase
        .from('topping_group_options')
        .select('id')
        .eq('group_id', groupId)
        .eq('topping_id', toppingId)
        .maybeSingle()

      if (existing) {
        return ctx.reply('⚠️ This topping is already in that group.')
      }

      const [{ data: group }, { data: topping }] = await Promise.all([
        supabase.from('topping_groups').select('name').eq('id', groupId).maybeSingle(),
        supabase.from('toppings').select('name').eq('id', toppingId).maybeSingle()
      ])

      const { error } = await supabase
        .from('topping_group_options')
        .insert({ group_id: groupId, topping_id: toppingId })

      if (error) {
        console.error('[adminMenu] assignt_top_ insert error groupId:', groupId, 'toppingId:', toppingId, error.message, error)
        return ctx.reply(`❌ Failed to assign topping: ${error.message}`)
      }

      await ctx.reply(
        `✅ Topping *"${topping?.name || toppingId}"* added to group *"${group?.name || groupId}"* successfully!`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('[adminMenu] assignt_top_ unexpected error groupId:', groupId, 'toppingId:', toppingId, err.message, err)
      await ctx.reply('❌ An unexpected error occurred. Please try again.')
    }
  })

  // ─── GROUP TYPE SELECTION ────────────────────────────────────

  bot.action('group_type_single', async (ctx) => {
    const flow = await adminFlowState.get(ctx.from.id)
    if (!flow || flow.step !== 'awaiting_group_type') return ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { ...flow, step: 'awaiting_group_required', selection_type: 'single' })
    await ctx.answerCbQuery('single selected')
    await ctx.reply(
      'Is this group required?',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'group_req_yes')],
        [Markup.button.callback('❌ No', 'group_req_no')]
      ])
    )
  })

  bot.action('group_type_multiple', async (ctx) => {
    const flow = await adminFlowState.get(ctx.from.id)
    if (!flow || flow.step !== 'awaiting_group_type') return ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { ...flow, step: 'awaiting_group_required', selection_type: 'multiple' })
    await ctx.answerCbQuery('multiple selected')
    await ctx.reply(
      'Is this group required?',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'group_req_yes')],
        [Markup.button.callback('❌ No', 'group_req_no')]
      ])
    )
  })

  bot.action('group_req_yes', async (ctx) => {
    const flow = await adminFlowState.get(ctx.from.id)
    if (!flow || flow.step !== 'awaiting_group_required') return ctx.answerCbQuery()
    await createToppingGroup(ctx, flow.name, flow.selection_type, true)
  })

  bot.action('group_req_no', async (ctx) => {
    const flow = await adminFlowState.get(ctx.from.id)
    if (!flow || flow.step !== 'awaiting_group_required') return ctx.answerCbQuery()
    await createToppingGroup(ctx, flow.name, flow.selection_type, false)
  })

  async function createToppingGroup(ctx, name, selectionType, required) {
    await adminFlowState.delete(ctx.from.id)
    const { error } = await supabase.from('topping_groups').insert({ name, selection_type: selectionType, required })
    if (error) {
      await ctx.answerCbQuery('Error')
      return ctx.reply(`❌ ${error.message}`)
    }
    await ctx.answerCbQuery('Created')
    await ctx.reply(`✅ Group "${name}" created (${selectionType}, ${required ? 'required' : 'optional'}).`)
  }
}
