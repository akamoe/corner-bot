import 'dotenv/config'
import { Telegraf, Markup } from 'telegraf'
import { getOrCreateUser, getStaffRole, hashTelegramId } from '../lib/auth.js'
import { getCategories, getItemsByCategory, getMenuItem } from '../lib/menu.js'
import { getAvailableSlots } from '../lib/slots.js'
import { getCart, addItemToCart, removeItemFromCart, clearCart, updateCartItemQuantity } from '../lib/cart.js'
import { confirmOrder, updateOrderStatus, getOrderByCode, getPendingOrders } from '../lib/orders.js'
import { getItemToppingGroups, getAllToppings, getAllGroups, parseCustomization, stringifyCustomization } from '../lib/toppings.js'
import { notifyCashiers, notifyStudent } from '../lib/notifications.js'
import { requireAdmin, requireStaff } from '../lib/middleware.js'
import { adminFlowState, orderFlowState } from '../lib/state.js'
import { setupAdminCommands } from '../lib/admin-commands.js'
import supabase from '../lib/supabase.js'

const bot = new Telegraf(process.env.BOT_TOKEN)

setupAdminCommands(bot)

// Register commands with Telegram so they show in the / menu
bot.command('setup_commands', requireAdmin, async (ctx) => {
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'addcashier', description: 'Add a cashier (admin only)' },
    { command: 'removecashier', description: 'Remove a cashier (admin only)' },
    { command: 'add_category', description: 'Add a category (admin only)' },
    { command: 'add_item', description: 'Add a menu item (admin only)' },
    { command: 'add_topping', description: 'Add a topping (admin only)' },
    { command: 'add_group', description: 'Add a topping group (admin only)' },
    { command: 'assign_group_to_item', description: 'Assign group to item (admin only)' },
    { command: 'assign_topping_to_group', description: 'Assign topping to group (admin only)' },
    { command: 'status', description: 'Check your active order' },
    { command: 'cart', description: 'View your cart' },
    { command: 'help', description: 'Show help' }
  ]).catch(err => console.error('Failed to set commands:', err.message))
  ctx.reply('Commands updated successfully.')
})

// ─── GLOBAL ERROR HANDLER ───────────────────────────────────

bot.catch((err, ctx) => {
  console.error('Telegraf error:', err)
  if (ctx) {
    ctx.reply('Oops, something went wrong. Please try again.').catch(console.error)
  }
})

// ─── HELPERS ────────────────────────────────────────────────

// === MODIFIED === formatOrderSummary now shows toppings from customization JSON
function formatOrderSummary(order, items) {
  const lines = items.map(i => {
    const custom = parseCustomization(i.customization)
    const toppingNames = custom.toppings.map(t => t.name).join(', ')
    const toppingLine = toppingNames ? `   └ 🧀 ${toppingNames}` : ''
    return `• ${i.item_name} x${i.quantity} — ${(i.item_price * i.quantity).toFixed(2)} IQD${toppingLine ? '\n' + toppingLine : ''}`
  })
  return lines.join('\n')
}

// === NEW === Helper to build customization keyboard for a group
function buildToppingKeyboard(group, selectedToppingIds) {
  const buttons = group.toppings.map(t => {
    const isSelected = selectedToppingIds.includes(t.id)
    const prefix = isSelected ? '✅' : '⭕'
    return [Markup.button.callback(`${prefix} ${t.name} (+${Number(t.price || 0).toFixed(2)} IQD)`, `toggle_topping_${t.id}`)]
  })
  return buttons
}

// === NEW === Helper to calculate final price with toppings
function calculateFinalPrice(basePrice, selectedToppingIds, groups) {
  let extra = 0
  const allToppings = groups.flatMap(g => g.toppings)
  for (const tid of selectedToppingIds) {
    const t = allToppings.find(x => x.id === tid)
    if (t) extra += Number(t.price || 0)
  }
  return basePrice + extra
}

// === NEW === Helper to validate required groups are satisfied
function validateRequiredGroups(groups, selectedToppingIds) {
  for (const g of groups) {
    if (g.required) {
      const hasSelection = g.toppings.some(t => selectedToppingIds.includes(t.id))
      if (!hasSelection) return false
    }
  }
  return true
}

function isoDay(date) {
  // YYYY-MM-DD
  return new Date(date).toISOString().split('T')[0]
}

function todayIso() {
  return isoDay(new Date())
}

function daysAgoIso(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDay(d)
}

function adminKeyboard() {
  return Markup.keyboard([
    ['📋 View Orders', '🍽 Manage Menu'],
    ['👤 Manage Staff', '🕐 Manage Slots'],
    ['📊 Analytics', '📢 Broadcast'],
    ['🧹 Clear Chat']
  ]).resize()
}

// ─── /start ─────────────────────────────────────────────────

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const role = await getStaffRole(ctx.from.id)

  // Cancel any running admin flow when /start is hit
  await adminFlowState.delete(ctx.from.id)
  await orderFlowState.delete(ctx.from.id) // === NEW ===

  if (role === 'admin') {
    return ctx.reply(
      `👑 Welcome back, Admin!\n\nWhat would you like to manage?`,
      adminKeyboard()
    )
  }

  if (role === 'cashier') {
    return ctx.reply(
      `👋 أهلاً بالكاشير!\n\nاستخدم الأزرار أدناه لإدارة الطلبات الواردة.`,
      Markup.keyboard([
        ['📋 الطلبات النشطة'],
        ['🔍 البحث عن طلب']
      ]).resize()
    )
  }

  // Regular student
  return ctx.reply(
    `🌽 أهلاً بيك بـ *Corner*!\n\nأكل طازج يجهز لك بوقته. اطلب مسبقاً وما تنطر.`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        ['🍽 تصفح المنيو', '🛒 سلتي'],
        ['📦 طلباتي', '❓ مساعدة']
      ]).resize()
    }
  )
})

// ═══════════════════════════════════════════════════════════
// ADMIN HANDLERS — registered BEFORE bot.on('text') so they work
// ═══════════════════════════════════════════════════════════

// ─── ADMIN: VIEW ORDERS ──────────────────────────────────────

bot.hears('📋 View Orders', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

  const buttons = []
  for (let i = 0; i < 7; i++) {
    const day = daysAgoIso(i)
    const label = i === 0 ? `Today (${day})` : i === 1 ? `Yesterday (${day})` : day
    buttons.push([Markup.button.callback(`📅 ${label}`, `vieworders_${day}`)])
  }
  buttons.push([Markup.button.callback('🗓 Custom Date', 'vieworders_custom')])

  await ctx.reply(
    '📋 *View Orders*\n\nSelect a day:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  )
})

bot.action('vieworders_custom', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  await adminFlowState.set(ctx.from.id, { step: 'awaiting_orders_date' })
  await ctx.reply('🗓 Send the date you want to view (format: *YYYY-MM-DD*)', { parse_mode: 'Markdown' })
})

async function showOrdersForDay(ctx, day) {
  const start = `${day}T00:00:00`
  const end = `${day}T23:59:59`

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*, order_items(*), pickup_slots(label), users(anonymous_token)')
    .neq('status', 'pending')
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('View Orders error:', error.message)
    return ctx.reply(`❌ Error: ${error.message}`)
  }

  if (!orders?.length) {
    return ctx.reply(
      `📭 No orders for *${day}*.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💰 Total Sales', `totalsales_${day}`)]
        ])
      }
    )
  }

  await ctx.reply(`📋 *Orders for ${day}* — ${orders.length} order(s)`, { parse_mode: 'Markdown' })

  for (const order of orders) {
    const items = order.order_items.map(i => `• ${i.item_name} x${i.quantity}`).join('\n') || '(no items)'
    const text =
      `🎫 *${order.order_code}*\n` +
      `👤 Token: ${order.users?.anonymous_token || 'N/A'}\n` +
      `🕐 Pickup: ${order.pickup_slots?.label || 'N/A'}\n` +
      `📋 Status: ${String(order.status).toUpperCase()}\n` +
      `💰 ${Number(order.total_amount || 0).toFixed(2)} IQD\n\n` +
      `${items}`
    await ctx.reply(text, { parse_mode: 'Markdown' })
  }

  await ctx.reply(
    `✅ End of ${day}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💰 Total Sales', `totalsales_${day}`)]
    ])
  )
}

bot.action(/^vieworders_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  const day = ctx.match[1]
  await showOrdersForDay(ctx, day)
})

bot.action(/^totalsales_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  const day = ctx.match[1]
  const start = `${day}T00:00:00`
  const end = `${day}T23:59:59`

  const { data: orders, error } = await supabase
    .from('orders')
    .select('total_amount, status')
    .neq('status', 'pending')
    .neq('status', 'cancelled')
    .gte('created_at', start)
    .lte('created_at', end)

  if (error) {
    return ctx.reply(`❌ Error: ${error.message}`)
  }

  const totalOrders = orders?.length || 0
  const totalSales = (orders || []).reduce((s, o) => s + Number(o.total_amount || 0), 0)

  await ctx.reply(
    `💰 *Total Sales — ${day}*\n\n` +
    `📦 Orders: *${totalOrders}*\n` +
    `💵 Revenue: *${totalSales.toFixed(2)} IQD*`,
    { parse_mode: 'Markdown' }
  )
})

// ─── ADMIN: MANAGE MENU ──────────────────────────────────────

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

// === NEW === Admin: Add Topping inline flow
bot.action('menu_add_topping', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  await adminFlowState.set(ctx.from.id, { step: 'awaiting_topping_name' })
  await ctx.reply('🧀 Send the *name* of the new topping.', { parse_mode: 'Markdown' })
})

// === NEW === Admin: Add Group inline flow
bot.action('menu_add_group', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  await adminFlowState.set(ctx.from.id, { step: 'awaiting_group_name' })
  await ctx.reply('📦 Send the *name* of the new topping group.', { parse_mode: 'Markdown' })
})

// === NEW === Admin: Assign Group to Item inline flow
bot.action('menu_assign_group', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()

  const { data: items } = await supabase.from('menu_items').select('id, name').eq('is_available', true).order('name')
  if (!items?.length) return ctx.reply('No items available.')

  const buttons = items.map(i => [Markup.button.callback(i.name, `assigngrp_item_${i.id}`)])
  await ctx.reply('Select an item to assign a group to:', Markup.inlineKeyboard(buttons))
})

// Step 1: admin picks the item — store itemId in state, show groups with SHORT callbacks
bot.action(/^assigngrp_item_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  const itemId = ctx.match[1]

  const { data: groups } = await supabase.from('topping_groups').select('id, name').order('name')
  if (!groups?.length) return ctx.reply('No topping groups exist. Create one first.')

  // Store itemId so the next step can read it (avoids exceeding Telegram's 64-byte callback_data limit)
  await adminFlowState.set(ctx.from.id, { step: 'selecting_group_for_item', itemId })

  // pick_grp_<UUID> = 9 + 36 = 45 bytes ✅ (was 89 bytes with two UUIDs)
  const buttons = groups.map(g => [Markup.button.callback(g.name, `pick_grp_${g.id}`)])
  await ctx.reply('Select a group to assign:', Markup.inlineKeyboard(buttons))
})

// Step 2: admin picks the group — read itemId from state, insert
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
    // Prevent duplicate assignments
    const { data: existing } = await supabase
      .from('item_topping_groups')
      .select('id')
      .eq('menu_item_id', itemId)
      .eq('group_id', groupId)
      .maybeSingle()

    if (existing) {
      return ctx.reply('⚠️ This group is already assigned to that item.')
    }

    // Fetch names for a meaningful confirmation (parallel)
    const [{ data: item }, { data: group }] = await Promise.all([
      supabase.from('menu_items').select('name').eq('id', itemId).maybeSingle(),
      supabase.from('topping_groups').select('name').eq('id', groupId).maybeSingle()
    ])

    const { error } = await supabase
      .from('item_topping_groups')
      .insert({ menu_item_id: itemId, group_id: groupId })

    if (error) {
      console.error('pick_grp_ insert error:', error.message)
      return ctx.reply(`❌ Failed to assign group: ${error.message}`)
    }

    await ctx.reply(
      `✅ Group *"${group?.name || groupId}"* assigned to item *"${item?.name || itemId}"* successfully!`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    console.error('pick_grp_ unexpected error:', err.message)
    await ctx.reply('❌ An unexpected error occurred. Please try again.')
  }
})

// === NEW === Admin: Assign Topping to Group inline flow
bot.action('menu_assign_topping', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()

  const { data: groups } = await supabase.from('topping_groups').select('id, name').order('name')
  if (!groups?.length) return ctx.reply('No topping groups exist.')

  const buttons = groups.map(g => [Markup.button.callback(g.name, `assignt_group_${g.id}`)])
  await ctx.reply('Select a group:', Markup.inlineKeyboard(buttons))
})

// Step 1: admin picks the group — store groupId in state, show toppings with SHORT callbacks
bot.action(/^assignt_group_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  const groupId = ctx.match[1]

  const { data: toppings } = await supabase.from('toppings').select('id, name').eq('is_active', true).order('name')
  if (!toppings?.length) return ctx.reply('No toppings available.')

  // Store groupId so the next step can read it (avoids exceeding Telegram's 64-byte callback_data limit)
  await adminFlowState.set(ctx.from.id, { step: 'selecting_topping_for_group', groupId })

  // pick_top_<UUID> = 9 + 36 = 45 bytes ✅ (was 85 bytes with two UUIDs)
  const buttons = toppings.map(t => [Markup.button.callback(t.name, `pick_top_${t.id}`)])
  await ctx.reply('Select a topping to add to this group:', Markup.inlineKeyboard(buttons))
})

// Step 2: admin picks the topping — read groupId from state, insert
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
    // Prevent duplicate assignments
    const { data: existing } = await supabase
      .from('topping_group_options')
      .select('id')
      .eq('group_id', groupId)
      .eq('topping_id', toppingId)
      .maybeSingle()

    if (existing) {
      return ctx.reply('⚠️ This topping is already in that group.')
    }

    // Fetch names for a meaningful confirmation (parallel)
    const [{ data: group }, { data: topping }] = await Promise.all([
      supabase.from('topping_groups').select('name').eq('id', groupId).maybeSingle(),
      supabase.from('toppings').select('name').eq('id', toppingId).maybeSingle()
    ])

    const { error } = await supabase
      .from('topping_group_options')
      .insert({ group_id: groupId, topping_id: toppingId })

    if (error) {
      console.error('pick_top_ insert error:', error.message)
      return ctx.reply(`❌ Failed to assign topping: ${error.message}`)
    }

    await ctx.reply(
      `✅ Topping *"${topping?.name || toppingId}"* added to group *"${group?.name || groupId}"* successfully!`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    console.error('pick_top_ unexpected error:', err.message)
    await ctx.reply('❌ An unexpected error occurred. Please try again.')
  }
})

bot.action(/^assignt_top_(.+)_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  const [, groupId, toppingId] = ctx.match

  try {
    // Prevent duplicate assignments
    const { data: existing } = await supabase
      .from('topping_group_options')
      .select('id')
      .eq('group_id', groupId)
      .eq('topping_id', toppingId)
      .maybeSingle()

    if (existing) {
      return ctx.reply('⚠️ This topping is already in that group.')
    }

    // Fetch names for a meaningful confirmation (parallel)
    const [{ data: group }, { data: topping }] = await Promise.all([
      supabase.from('topping_groups').select('name').eq('id', groupId).maybeSingle(),
      supabase.from('toppings').select('name').eq('id', toppingId).maybeSingle()
    ])

    const { error } = await supabase
      .from('topping_group_options')
      .insert({ group_id: groupId, topping_id: toppingId })

    if (error) {
      console.error('assignt_top_ insert error:', error.message)
      return ctx.reply(`❌ Failed to assign topping: ${error.message}`)
    }

    await ctx.reply(
      `✅ Topping *"${topping?.name || toppingId}"* added to group *"${group?.name || groupId}"* successfully!`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    console.error('assignt_top_ unexpected error:', err.message)
    await ctx.reply('❌ An unexpected error occurred. Please try again.')
  }
})

// ─── ADMIN: MANAGE STAFF ─────────────────────────────────────

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
    'Step 1 of 2: Please send the cashier\'s *Telegram ID* (numeric).\n\n' +
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
    '🗑 *Remove Cashier*\n\nSend the cashier\'s *Telegram ID* to remove.',
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

// ─── ADMIN: MANAGE SLOTS ─────────────────────────────────────

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

// ─── ADMIN: BROADCAST ────────────────────────────────────────

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

  let sent = 0
  let failed = 0
  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u.telegram_id, `📢 *Announcement*\n\n${message}`, { parse_mode: 'Markdown' })
      sent++
    } catch (err) {
      failed++
      console.error(`Broadcast fail for ${u.telegram_id}:`, err.message)
    }
  }

  await ctx.reply(`✅ Broadcast complete.\n\n📬 Sent: ${sent}\n⚠️ Failed: ${failed}`)
})

bot.action('broadcast_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled')
  await adminFlowState.delete(ctx.from.id)
  await ctx.reply('❌ Broadcast cancelled.')
})

// ─── ADMIN: ANALYTICS ────────────────────────────────────────

bot.hears('📊 Analytics', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

  await ctx.reply(
    '📊 *Analytics*\n\nChoose a range:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Today', 'analytics_1')],
        [Markup.button.callback('Last 7 days', 'analytics_7')],
        [Markup.button.callback('Last 30 days', 'analytics_30')],
        [Markup.button.callback('Custom (# days)', 'analytics_custom')]
      ])
    }
  )
})

bot.action('analytics_custom', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  await adminFlowState.set(ctx.from.id, { step: 'awaiting_analytics_days' })
  await ctx.reply('🔢 How many days back? Send a positive integer (e.g. 14).')
})

bot.action(/^analytics_(\d+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  const days = parseInt(ctx.match[1], 10)
  await showAnalytics(ctx, days)
})

async function showAnalytics(ctx, days) {
  const from = daysAgoIso(days - 1)
  const start = `${from}T00:00:00`
  const end = `${todayIso()}T23:59:59`

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, status, total_amount, created_at, user_id, order_items(item_name, quantity, item_price)')
    .neq('status', 'pending')
    .gte('created_at', start)
    .lte('created_at', end)

  if (error) return ctx.reply(`❌ ${error.message}`)

  const all = orders || []
  const completed = all.filter(o => o.status !== 'cancelled')
  const cancelled = all.filter(o => o.status === 'cancelled')
  const revenue = completed.reduce((s, o) => s + Number(o.total_amount || 0), 0)
  const uniqueUsers = new Set(completed.map(o => o.user_id)).size

  // Top items
  const itemCounts = new Map()
  for (const o of completed) {
    for (const i of o.order_items || []) {
      const cur = itemCounts.get(i.item_name) || { qty: 0, revenue: 0 }
      cur.qty += i.quantity
      cur.revenue += Number(i.item_price || 0) * i.quantity
      itemCounts.set(i.item_name, cur)
    }
  }
  const topItems = [...itemCounts.entries()]
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 5)
    .map(([name, v], idx) => `${idx + 1}. ${name} — ${v.qty} sold (${v.revenue.toFixed(2)} IQD)`)
    .join('\n') || '(no items sold)'

  const avgOrder = completed.length ? revenue / completed.length : 0

  await ctx.reply(
    `📊 *Analytics — last ${days} day(s)*\n` +
    `(${from} → ${todayIso()})\n\n` +
    `📦 Orders: *${completed.length}* (cancelled: ${cancelled.length})\n` +
    `💵 Revenue: *${revenue.toFixed(2)} IQD*\n` +
    `🧾 Avg order: *${avgOrder.toFixed(2)} IQD*\n` +
    `👥 Unique customers: *${uniqueUsers}*\n\n` +
    `🏆 *Top items*\n${topItems}`,
    { parse_mode: 'Markdown' }
  )
}

// ═══════════════════════════════════════════════════════════
// STUDENT HANDLERS
// ═══════════════════════════════════════════════════════════

// ─── BROWSE MENU ─────────────────────────────────────────────

bot.hears(['🍽 تصفح المنيو', '🍽 Browse Menu'], async (ctx) => {
  const categories = await getCategories()

  if (!categories.length) {
    return ctx.reply('ما في أصناف متاحة هسة. رجع لاحقاً!')
  }

  const buttons = categories.map(c =>
    [Markup.button.callback(`${c.emoji || '🍴'} ${c.name}`, `cat_${c.id}`)]
  )

  return ctx.reply(
    '📋 *منيونا*\n\nاختار الفئة:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  )
})

// === MODIFIED === cat_ now shows items with "Customize" button instead of direct add
bot.action(/^cat_(.+)$/, async (ctx) => {
  const categoryId = ctx.match[1]
  const items = await getItemsByCategory(categoryId)

  if (!items.length) {
    return ctx.answerCbQuery('ما في وجبات بهاي الفئة هسة.')
  }

  await ctx.answerCbQuery()

  for (const item of items) {
    const text = `*${item.name}*\n${item.description || ''}\n\n💰 ${item.price.toFixed(2)} IQD`
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ تخصيص الوجبة', `item_${item.id}`)],
      ])
    })
  }
})

// === NEW === User selects an item → start customization flow
bot.action(/^item_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1]
  const menuItem = await getMenuItem(itemId)

  if (!menuItem) return ctx.answerCbQuery('ما لقينا الوجبة.')

  await ctx.answerCbQuery()

  const groups = await getItemToppingGroups(itemId)

  // Initialize order flow state
  await orderFlowState.set(ctx.from.id, {
    step: 'customizing',
    itemId: menuItem.id,
    itemName: menuItem.name,
    basePrice: Number(menuItem.price),
    selectedToppings: [],
    quantity: 1,
    groups
  })

  await sendCustomizationMessage(ctx, ctx.from.id)
})

// === NEW === Send/refresh the customization UI message
async function sendCustomizationMessage(ctx, userId) {
  const state = await orderFlowState.get(userId)
  if (!state || state.step !== 'customizing') return

  const { itemName, basePrice, selectedToppings, quantity, groups } = state
  const finalPrice = calculateFinalPrice(basePrice, selectedToppings, groups)

  let text = `⚙️ *${itemName}*\n💰 السعر: ${finalPrice.toFixed(2)} IQD × ${quantity} = *${(finalPrice * quantity).toFixed(2)} IQD*\n\n`

  const keyboard = []

  for (const group of groups) {
    text += `📦 *${group.name}* ${group.required ? '(مطلوب)' : ''} [${group.selection_type === 'single' ? 'اختيار واحد' : 'متعدد'}]\n`

    for (const t of group.toppings) {
      const isSelected = selectedToppings.includes(t.id)
      text += `${isSelected ? '✅' : '○'} ${t.name} ${Number(t.price || 0) > 0 ? `(+${Number(t.price).toFixed(2)} IQD)` : ''}\n`
    }

    text += '\n'

    // Add toggle buttons for this group
    for (const t of group.toppings) {
      const isSelected = selectedToppings.includes(t.id)
      const label = `${isSelected ? '✅' : '⭕'} ${t.name}`
      keyboard.push([Markup.button.callback(label, `toggle_topping_${t.id}`)])
    }
  }

  if (groups.length === 0) {
    text += '(ماكو إضافات متاحة)\n\n'
  }

  // Quantity controls
  keyboard.push([
    Markup.button.callback('➖', 'qty_down'),
    Markup.button.callback(`الكمية: ${quantity}`, 'qty_noop'),
    Markup.button.callback('➕', 'qty_up')
  ])

  // Confirm button (disabled if required groups not satisfied)
  const canConfirm = validateRequiredGroups(groups, selectedToppings)
  if (canConfirm) {
    keyboard.push([Markup.button.callback('✅ أضف للسلة', 'confirm_item')])
  } else {
    keyboard.push([Markup.button.callback(' أكمل الاختيارات المطلوبة', 'confirm_item_disabled')])
  }

  keyboard.push([Markup.button.callback('❌ إلغاء', 'cancel_customize')])

  // Try to edit existing message, otherwise send new
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      })
    } else {
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      })
    }
  } catch (err) {
    // If edit fails (e.g. message unchanged), just answer cb
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    })
  }
}

// === NEW === Toggle topping selection
bot.action(/^toggle_topping_(.+)$/, async (ctx) => {
  const toppingId = ctx.match[1]
  const userId = ctx.from.id
  const state = await orderFlowState.get(userId)

  if (!state || state.step !== 'customizing') {
    return ctx.answerCbQuery('انتهت الجلسة. ابدأ من جديد.')
  }

  const group = state.groups.find(g => g.toppings.some(t => t.id === toppingId))
  if (!group) return ctx.answerCbQuery('Topping not found.')

  const isSelected = state.selectedToppings.includes(toppingId)

  if (isSelected) {
    // Deselect
    state.selectedToppings = state.selectedToppings.filter(id => id !== toppingId)
  } else {
    // Select — if single-selection group, deselect others in same group first
    if (group.selection_type === 'single') {
      const groupToppingIds = group.toppings.map(t => t.id)
      state.selectedToppings = state.selectedToppings.filter(id => !groupToppingIds.includes(id))
    }
    state.selectedToppings.push(toppingId)
  }

  await ctx.answerCbQuery(isSelected ? 'تم الإلغاء' : 'تم الاختيار')
  await sendCustomizationMessage(ctx, userId)
})

// === NEW === Quantity controls
bot.action('qty_up', async (ctx) => {
  const state = await orderFlowState.get(ctx.from.id)
  if (!state || state.step !== 'customizing') return ctx.answerCbQuery('Session expired.')
  state.quantity += 1
  await ctx.answerCbQuery(`الكمية: ${state.quantity}`)
  await sendCustomizationMessage(ctx, ctx.from.id)
})

bot.action('qty_down', async (ctx) => {
  const state = await orderFlowState.get(ctx.from.id)
  if (!state || state.step !== 'customizing') return ctx.answerCbQuery('Session expired.')
  if (state.quantity > 1) {
    state.quantity -= 1
    await ctx.answerCbQuery(`الكمية: ${state.quantity}`)
  } else {
    await ctx.answerCbQuery('الحد الأدنى 1')
  }
  await sendCustomizationMessage(ctx, ctx.from.id)
})

bot.action('qty_noop', async (ctx) => ctx.answerCbQuery())
bot.action('confirm_item_disabled', async (ctx) => ctx.answerCbQuery('أكمل الاختيارات المطلوبة أولاً'))

// === NEW === Confirm customization and add to cart
bot.action('confirm_item', async (ctx) => {
  const userId = ctx.from.id
  const state = await orderFlowState.get(userId)

  if (!state || state.step !== 'customizing') {
    return ctx.answerCbQuery('انتهت الجلسة.')
  }

  if (!validateRequiredGroups(state.groups, state.selectedToppings)) {
    return ctx.answerCbQuery('أكمل الاختيارات المطلوبة.')
  }

  const { itemId, itemName, basePrice, selectedToppings, quantity, groups } = state
  const finalPrice = calculateFinalPrice(basePrice, selectedToppings, groups)

  // Build toppings array for customization JSON
  const allToppings = groups.flatMap(g => g.toppings)
  const selectedToppingsData = selectedToppings.map(tid => {
    const t = allToppings.find(x => x.id === tid)
    return { id: tid, name: t.name, price: Number(t.price || 0) }
  })

  const customization = stringifyCustomization(selectedToppingsData)

  const menuItem = { id: itemId, name: itemName, price: finalPrice }
  const user = await getOrCreateUser(userId)
  await addItemToCart(user.id, menuItem, quantity, customization)

  await orderFlowState.delete(userId)

  await ctx.answerCbQuery(`✅ ${itemName} انضاف للسلة!`)
  await ctx.editMessageText(
    `✅ *${itemName}* أُضيف للسلة!\nالكمية: ${quantity}\nالسعر: ${(finalPrice * quantity).toFixed(2)} IQD`,
    { parse_mode: 'Markdown' }
  )
})

bot.action('cancel_customize', async (ctx) => {
  await orderFlowState.delete(ctx.from.id)
  await ctx.answerCbQuery('تم الإلغاء.')
  await ctx.editMessageText('❌ تم الإلغاء.')
})

// === MODIFIED === Keep old add_ handler for backward compatibility (items without groups)
bot.action(/^add_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1]
  const menuItem = await getMenuItem(itemId)

  if (!menuItem) return ctx.answerCbQuery('ما لقينا الوجبة.')

  const user = await getOrCreateUser(ctx.from.id)
  await addItemToCart(user.id, menuItem)
  await ctx.answerCbQuery(`✅ ${menuItem.name} انضاف للسلة!`)
})

// ─── CART ────────────────────────────────────────────────────

// === MODIFIED === Cart now shows toppings and per-item controls
bot.hears(['🛒 سلتي', '🛒 My Cart'], async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const cart = await getCart(user.id)

  if (!cart || !cart.order_items?.length) {
    return ctx.reply(
      '🛒 سلتك فاضية.\n\nتصفح المنيو وأضف وجبات!',
      Markup.keyboard([
        ['🍽 تصفح المنيو', '🛒 سلتي'],
        ['📦 طلباتي', '❓ مساعدة']
      ]).resize()
    )
  }

  const items = cart.order_items
  const total = items.reduce((s, i) => s + i.item_price * i.quantity, 0)
  const summary = formatOrderSummary(cart, items)

  await ctx.reply(
    `🛒 *سلتك*\n\n${summary}\n\n*المجموع: ${total.toFixed(2)} IQD*`,
    { parse_mode: 'Markdown' }
  )

  // === NEW === Send each cart item as a separate message with controls
  for (const i of items) {
    const custom = parseCustomization(i.customization)
    const toppingNames = custom.toppings.map(t => t.name).join(', ')
    let text = `• ${i.item_name}\n`
    if (toppingNames) text += `  🧀 ${toppingNames}\n`
    text += `  💰 ${i.item_price.toFixed(2)} IQD × ${i.quantity}`

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('➕', `cart_qty_up_${i.id}`),
          Markup.button.callback('➖', `cart_qty_down_${i.id}`),
          Markup.button.callback('❌ إزالة', `cart_rm_${i.id}`)
        ]
      ])
    })
  }

  await ctx.reply(
    'استمر بالتعديل أو أكد الطلب:',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ تأكيد الطلب', 'confirm_order')],
      [Markup.button.callback('🗑 تفريغ السلة', 'clear_cart')]
    ])
  )
})

// === MODIFIED === remove_ still works for backward compatibility
bot.action(/^remove_(.+)$/, async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  await removeItemFromCart(user.id, ctx.match[1])
  await ctx.answerCbQuery('تم الحذف.')
  await ctx.deleteMessage()
})

// === NEW === Per-item cart controls
bot.action(/^cart_qty_up_(.+)$/, async (ctx) => {
  const orderItemId = ctx.match[1]
  await updateCartItemQuantity(orderItemId, 1)
  await ctx.answerCbQuery('تمت الزيادة.')
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ تم التحديث')
})

bot.action(/^cart_qty_down_(.+)$/, async (ctx) => {
  const orderItemId = ctx.match[1]
  const newQty = await updateCartItemQuantity(orderItemId, -1)
  await ctx.answerCbQuery('تم النقصان.')
  if (newQty === null) {
    await ctx.deleteMessage()
  } else {
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ تم التحديث')
  }
})

// Renamed from remove_item_ to cart_rm_ to avoid collision with the legacy remove_ regex
bot.action(/^cart_rm_(.+)$/, async (ctx) => {
  const orderItemId = ctx.match[1]
  try {
    await removeItemFromCart(null, orderItemId)
    await ctx.answerCbQuery('تم الحذف.')
    await ctx.deleteMessage()
  } catch (err) {
    console.error('cart_rm_ error:', err.message)
    await ctx.answerCbQuery('❌ فشل الحذف، جرب ثاني.')
  }
})

bot.action('clear_cart', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  await clearCart(user.id)
  await ctx.answerCbQuery('تم التفريغ.')
  await ctx.editMessageText('🗑 تم تفريغ سلتك.')
})

// ─── CONFIRM ORDER → PICK SLOT ───────────────────────────────

bot.action('confirm_order', async (ctx) => {
  await ctx.answerCbQuery()
  const slots = await getAvailableSlots()

  if (!slots.length) {
    return ctx.reply('⚠️ ما في أوقات استلام متاحة هسة. جرب بعدين.')
  }

  const buttons = slots.map(s => [
    Markup.button.callback(
      `🕐 ${s.label} — ${s.spots_left} مكان متبقي`,
      `slot_${s.id}`
    )
  ])

  await ctx.reply(
    '📅 *اختار وقت الاستلام:*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  )
})

bot.action(/^slot_(.+)$/, async (ctx) => {
  const slotId = ctx.match[1]
  const user = await getOrCreateUser(ctx.from.id)
  const cart = await getCart(user.id)

  if (!cart || !cart.order_items?.length) {
    return ctx.answerCbQuery('سلتك فاضية.')
  }

  await ctx.answerCbQuery()
  const order = await confirmOrder(cart.id, slotId)

  const { data: slot, error: slotError } = await supabase
    .from('pickup_slots')
    .select('label')
    .eq('id', slotId)
    .maybeSingle()

  if (slotError) {
    console.error('Error fetching slot:', slotError.message)
  }

  await ctx.reply(
    `✅ *تم تأكيد طلبك!*\n\n` +
    `🎫 رمز طلبك: *${order.order_code}*\n` +
    `🕐 وقت الاستلام: *${slot?.label || 'N/A'}*\n\n` +
    `وريهم هذا الرمز عند الكاونتر لمن توصل.\n` +
    `راح تجيك إشعار لما يجهز طلبك!`,
    { parse_mode: 'Markdown' }
  )

  await notifyCashiers(bot, order)
})

// ─── MY ORDERS ───────────────────────────────────────────────

bot.hears(['📦 طلباتي', '📦 My Orders'], async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*, pickup_slots(label), order_items(*)')
    .eq('user_id', user.id)
    .neq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    console.error('Error fetching orders:', error.message)
    return ctx.reply('⚠️ ما قدرنا نحمل طلباتك. جرب ثاني.')
  }

  if (!orders?.length) {
    return ctx.reply('ما عندك طلبات سابقة.')
  }

  const statusEmoji = {
    confirmed: '✅',
    preparing: '👨‍🍳',
    ready: '🔔',
    picked_up: '✔️',
    cancelled: '❌'
  }

  const statusAr = {
    confirmed: 'مؤكد',
    preparing: 'يتحضر',
    ready: 'جاهز',
    picked_up: 'تم الاستلام',
    cancelled: 'ملغي'
  }

  const text = orders.map(o =>
    `${statusEmoji[o.status] || '•'} *${o.order_code}* — ${statusAr[o.status] || o.status}\n` +
    `🕐 ${o.pickup_slots?.label || 'N/A'} | 💰 ${o.total_amount?.toFixed(2)} IQD`
  ).join('\n\n')

  await ctx.reply(`📦 *طلباتك الأخيرة*\n\n${text}`, { parse_mode: 'Markdown' })
})

// ═══════════════════════════════════════════════════════════
// CASHIER HANDLERS
// ═══════════════════════════════════════════════════════════

bot.hears(['📋 الطلبات النشطة', '📋 Active Orders'], async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.reply('⛔ Unauthorized.')

  const orders = await getPendingOrders()

  if (!orders.length) {
    return ctx.reply('✅ ما في طلبات نشطة هسة.')
  }

  for (const order of orders) {
    const items = order.order_items.map(i => `• ${i.item_name} x${i.quantity}`).join('\n')
    const statusAr = { confirmed: 'مؤكد', preparing: 'يتحضر', ready: 'جاهز', picked_up: 'تم الاستلام', cancelled: 'ملغي' }
    const text =
      `🎫 *${order.order_code}*\n` +
      `👤 المستخدم: ${order.users?.anonymous_token}\n` +
      `🕐 وقت الاستلام: ${order.pickup_slots?.label}\n` +
      `📋 الحالة: ${statusAr[order.status] || order.status}\n\n` +
      `${items}`

    const buttons = []
    if (order.status === 'confirmed') {
      buttons.push([Markup.button.callback('👨‍🍳 قيد التحضير', `status_${order.id}_preparing`)])
    }
    if (order.status === 'preparing') {
      buttons.push([Markup.button.callback('🔔 جاهز', `status_${order.id}_ready`)])
    }
    if (order.status === 'ready') {
      buttons.push([Markup.button.callback('✔️ تم الاستلام', `status_${order.id}_picked_up`)])
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    })
  }
})

bot.action(/^status_(.+)_(confirmed|preparing|ready|picked_up|cancelled)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.answerCbQuery('Unauthorized.')

  const orderId = ctx.match[1]
  const newStatus = ctx.match[2]

  const order = await updateOrderStatus(orderId, newStatus)
  await ctx.answerCbQuery(`Order marked as ${newStatus}`)

  let newText = ctx.callbackQuery.message.text.replace(/\n\n✅ (تم التحديث إلى:|Updated to:)[\s\S]*$/, '')
  const statusAr = { preparing: 'يتحضر', ready: 'جاهز', picked_up: 'تم الاستلام', cancelled: 'ملغي', confirmed: 'مؤكد' }
  newText += `\n\n✅ تم التحديث إلى: *${statusAr[newStatus] || newStatus}*`

  const buttons = []
  if (newStatus === 'preparing') {
    buttons.push([Markup.button.callback('🔔 جاهز', `status_${orderId}_ready`)])
  } else if (newStatus === 'ready') {
    buttons.push([Markup.button.callback('✔️ تم الاستلام', `status_${orderId}_picked_up`)])
  }

  await ctx.editMessageText(
    newText,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  )

  await notifyStudent(bot, order, newStatus)
})

bot.hears(['🔍 البحث عن طلب', '🔍 Look Up Order'], async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.reply('⛔ Unauthorized.')
  await ctx.reply('أدخل رمز الطلب (مثال: ORD-4A2B1):')
})

// ═══════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════

bot.command('status', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)

  const { data: order, error } = await supabase
    .from('orders')
    .select('*, pickup_slots(label)')
    .eq('user_id', user.id)
    .in('status', ['confirmed', 'preparing', 'ready'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('Error fetching active order:', error.message)
    return ctx.reply('⚠️ ما قدرنا نحمل طلبك. جرب ثاني.')
  }

  if (!order) return ctx.reply('ما عندك طلبات نشطة هسة.')

  const statusEmoji = {
    confirmed: '✅ مؤكد — ينتظر التحضير',
    preparing: '👨‍🍳 يتحضر هسة!',
    ready: '🔔 جاهز — تعال خذه!'
  }

  await ctx.reply(
    `📦 *الطلب ${order.order_code}*\n\n` +
    `${statusEmoji[order.status]}\n` +
    `🕐 وقت الاستلام: ${order.pickup_slots?.label}`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('cancel', async (ctx) => {
  if (await adminFlowState.has(ctx.from.id)) {
    await adminFlowState.delete(ctx.from.id)
    return ctx.reply('❌ Cancelled.')
  }
  if (await orderFlowState.has(ctx.from.id)) {
    await orderFlowState.delete(ctx.from.id)
    return ctx.reply('❌ Cancelled.')
  }
  return ctx.reply('Nothing to cancel.')
})

bot.command('cart', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const cart = await getCart(user.id)

  if (!cart || !cart.order_items?.length) {
    return ctx.reply('🛒 سلتك فاضية.\n\nتصفح المنيو وأضف وجبات!')
  }

  const items = cart.order_items
  const total = items.reduce((s, i) => s + i.item_price * i.quantity, 0)
  const summary = formatOrderSummary(cart, items)

  await ctx.reply(
    `🛒 *سلتك*\n\n${summary}\n\n*المجموع: ${total.toFixed(2)} IQD*`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('help', async (ctx) => {
  await ctx.reply(
    `*مساعدة - Corner Bot*\n\n` +
    `🍽 *تصفح المنيو* — شوف الوجبات المتاحة اليوم\n` +
    `🛒 *سلتي* — شوف وادر سلتك\n` +
    `📦 *طلباتي* — تابع حالة طلبك\n\n` +
    `بعد ما تطلب راح تجيك *رمز*. وريه عند الكاونتر بوقت الاستلام.\n\n` +
    `عندك أسئلة؟ زورنا بـ Corner بالحرم الجامعي! 🌽`,
    { parse_mode: 'Markdown' }
  )
})

bot.hears(['❓ مساعدة', '❓ Help'], async (ctx) => {
  await ctx.reply(
    `*مساعدة - Corner Bot*\n\n` +
    `🍽 *تصفح المنيو* — شوف الوجبات المتاحة اليوم\n` +
    `🛒 *سلتي* — شوف وادر سلتك\n` +
    `📦 *طلباتي* — تابع حالة طلبك\n\n` +
    `بعد ما تطلب راح تجيك *رمز*. وريه عند الكاونتر بوقت الاستلام.\n\n` +
    `عندك أسئلة؟ زورنا بـ Corner بالحرم الجامعي! 🌽`,
    { parse_mode: 'Markdown' }
  )
})

// ─── ADMIN: CLEAR CHAT ───────────────────────────────────────

bot.hears('🧹 Clear Chat', requireAdmin, async (ctx) => {
  const currentMsgId = ctx.message.message_id
  const chatId = ctx.chat.id

  // Attempt to delete the last 80 messages (bot can only delete its own in private chats)
  const ids = Array.from({ length: 80 }, (_, i) => currentMsgId - i)
  await Promise.all(ids.map(id => ctx.telegram.deleteMessage(chatId, id).catch(() => {})))
})

// ═══════════════════════════════════════════════════════════
// TEXT HANDLER — must be registered LAST so bot.hears() work
// ═══════════════════════════════════════════════════════════

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  const userId = ctx.from.id
  const flow = await adminFlowState.get(userId)

  // ─── CASHIER FLOWS ──────────────────────────────────────
  if (!flow) {
    // ORD- lookup (staff only)
    if (text.toUpperCase().startsWith('ORD-')) {
      const role = await getStaffRole(userId)
      if (!role) return
      const order = await getOrderByCode(text)
      if (!order) return ctx.reply('❌ ما لقينا الطلب.')
      const items = order.order_items.map(i => `• ${i.item_name} x${i.quantity}`).join('\n')
      const statusAr = { confirmed: 'مؤكد', preparing: 'يتحضر', ready: 'جاهز', picked_up: 'تم الاستلام', cancelled: 'ملغي' }
      return ctx.reply(
        `🎫 *${order.order_code}*\n` +
        `🕐 وقت الاستلام: ${order.pickup_slots?.label}\n` +
        `📋 الحالة: ${statusAr[order.status] || order.status}\n\n` +
        `${items}`,
        { parse_mode: 'Markdown' }
      )
    }
    return
  }

  // ─── STAFF: ADD CASHIER ──────────────────────────────────
  if (flow.step === 'awaiting_cashier_id') {
    if (!/^\d+$/.test(text)) {
      return ctx.reply('❌ Invalid ID. Please send a numeric Telegram ID only.')
    }
    await adminFlowState.set(userId, { step: 'awaiting_cashier_username', telegramId: text })
    return ctx.reply(
      '✅ Telegram ID saved.\n\nStep 2 of 2: Now send the cashier\'s *username* (without @).',
      { parse_mode: 'Markdown' }
    )
  }

  if (flow.step === 'awaiting_cashier_username') {
    const { telegramId } = flow
    const username = text.replace(/^@/, '')
    const hash = hashTelegramId(telegramId)

    const { data: existing } = await supabase
      .from('staff')
      .select('*')
      .eq('telegram_hash', hash)
      .maybeSingle()

    const { error } = await supabase.from('staff').upsert({
      telegram_hash: hash,
      telegram_id: String(telegramId),
      telegram_username: username,
      role: 'cashier',
      is_active: true
    }, { onConflict: 'telegram_hash' })

    await adminFlowState.delete(userId)

    if (error) {
      console.error('Error adding cashier:', error.message)
      return ctx.reply('❌ Failed to add cashier. Please try again.')
    }

    return ctx.reply(existing
      ? `✅ Cashier @${username} updated successfully!`
      : `✅ Cashier @${username} added successfully!`)
  }

  if (flow.step === 'awaiting_remove_id') {
    if (!/^\d+$/.test(text)) {
      await adminFlowState.delete(userId)
      return ctx.reply('❌ Invalid ID. Please send a numeric Telegram ID only.')
    }
    const hash = hashTelegramId(text)
    const { error } = await supabase.from('staff').update({ is_active: false }).eq('telegram_hash', hash)
    await adminFlowState.delete(userId)
    if (error) {
      console.error('Error removing cashier:', error.message)
      return ctx.reply('❌ Failed to remove cashier.')
    }
    return ctx.reply('✅ Cashier removed.')
  }

  // ─── VIEW ORDERS: CUSTOM DATE ───────────────────────────
  if (flow.step === 'awaiting_orders_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return ctx.reply('❌ Invalid format. Use YYYY-MM-DD.')
    }
    await adminFlowState.delete(userId)
    return showOrdersForDay(ctx, text)
  }

  // ─── MENU FLOWS ─────────────────────────────────────────
  if (flow.step === 'awaiting_item_name') {
    const { error } = await supabase.from('menu_items').update({ name: text }).eq('id', flow.itemId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ Item name updated.')
  }

  if (flow.step === 'awaiting_item_price') {
    const price = parseFloat(text)
    if (isNaN(price) || price < 0) return ctx.reply('❌ Invalid price. Send a number.')
    const { error } = await supabase.from('menu_items').update({ price }).eq('id', flow.itemId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Price updated to ${price.toFixed(2)} IQD.`)
  }

  if (flow.step === 'awaiting_category_rename') {
    const { error } = await supabase.from('categories').update({ name: text }).eq('id', flow.categoryId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ Category renamed.')
  }

  if (flow.step === 'awaiting_new_category_name') {
    // split optional leading emoji + name
    const match = text.match(/^(\p{Extended_Pictographic})\s*(.+)$/u)
    const emoji = match ? match[1] : null
    const name = match ? match[2] : text
    const { error } = await supabase.from('categories').insert({ name, emoji, is_active: true, sort_order: 999 })
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Category "${name}" added.`)
  }

  if (flow.step === 'awaiting_new_item_name') {
    await adminFlowState.set(userId, { step: 'awaiting_new_item_price', categoryId: flow.categoryId, name: text })
    return ctx.reply('💲 Now send the *price* (numbers only).', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_item_price') {
    const price = parseFloat(text)
    if (isNaN(price) || price < 0) return ctx.reply('❌ Invalid price. Send a number.')
    await adminFlowState.set(userId, { step: 'awaiting_new_item_description', categoryId: flow.categoryId, name: flow.name, price })
    return ctx.reply('📝 Now send a short *description* (or send "-" for none).', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_item_description') {
    const description = text === '-' ? null : text
    const { error } = await supabase.from('menu_items').insert({
      category_id: flow.categoryId,
      name: flow.name,
      price: flow.price,
      description,
      is_available: true,
      sort_order: 999
    })
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Item "${flow.name}" added.`)
  }

  // ─── SLOT FLOWS ─────────────────────────────────────────
  if (flow.step === 'awaiting_slot_rename') {
    const { error } = await supabase.from('pickup_slots').update({ label: text }).eq('id', flow.slotId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ Slot renamed.')
  }

  if (flow.step === 'awaiting_slot_max') {
    const n = parseInt(text, 10)
    if (isNaN(n) || n < 1) return ctx.reply('❌ Send a positive integer.')
    const { error } = await supabase.from('pickup_slots').update({ max_orders: n }).eq('id', flow.slotId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Max orders set to ${n}.`)
  }

  if (flow.step === 'awaiting_new_slot_label') {
    await adminFlowState.set(userId, { step: 'awaiting_new_slot_time', label: text })
    return ctx.reply('🕐 Send the *time* for this slot in HH:MM format (24h, e.g. "12:00").', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_slot_time') {
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
      return ctx.reply('❌ Invalid time. Use HH:MM (e.g. 12:00).')
    }
    const slotTime = text.length === 5 ? `${text}:00` : text
    await adminFlowState.set(userId, { step: 'awaiting_new_slot_max', label: flow.label, slot_time: slotTime })
    return ctx.reply('🔢 Finally, send *max orders* for this slot.', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_slot_max') {
    const n = parseInt(text, 10)
    if (isNaN(n) || n < 1) return ctx.reply('❌ Send a positive integer.')
    const { error } = await supabase.from('pickup_slots').insert({
      label: flow.label,
      slot_time: flow.slot_time,
      max_orders: n,
      is_active: true
    })
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Slot "${flow.label}" added.`)
  }

  // ─── BROADCAST FLOW ─────────────────────────────────────
  if (flow.step === 'awaiting_broadcast_message') {
    await adminFlowState.set(userId, { step: 'awaiting_broadcast_confirm', message: text })
    return ctx.reply(
      `📢 *Preview:*\n\n${text}\n\nSend to all users?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Send', 'broadcast_confirm')],
          [Markup.button.callback('❌ Cancel', 'broadcast_cancel')]
        ])
      }
    )
  }

  // ─── ANALYTICS CUSTOM DAYS ──────────────────────────────
  if (flow.step === 'awaiting_analytics_days') {
    const n = parseInt(text, 10)
    if (isNaN(n) || n < 1 || n > 365) return ctx.reply('❌ Send a number between 1 and 365.')
    await adminFlowState.delete(userId)
    return showAnalytics(ctx, n)
  }

  // === NEW === TOPPING FLOWS ──────────────────────────────
  if (flow.step === 'awaiting_topping_name') {
    await adminFlowState.set(userId, { step: 'awaiting_topping_price', name: text })
    return ctx.reply('💲 Send the *price* for this topping (0 if free).', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_topping_price') {
    const price = parseFloat(text)
    if (isNaN(price) || price < 0) return ctx.reply('❌ Invalid price. Send a number.')
    await adminFlowState.set(userId, { step: 'awaiting_topping_tag', name: flow.name, price })
    return ctx.reply('🏷 Send an optional *tag* (e.g. "extra", "sauce") or "-" for none.', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_topping_tag') {
    const tag = text === '-' ? null : text
    const { error } = await supabase.from('toppings').insert({
      name: flow.name,
      price: flow.price,
      tag,
      is_active: true
    })
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Topping "${flow.name}" added.`)
  }

  // === NEW === GROUP FLOWS ────────────────────────────────
  if (flow.step === 'awaiting_group_name') {
    await adminFlowState.set(userId, { step: 'awaiting_group_type', name: text })
    return ctx.reply(
      '📋 Choose selection type:\n\nsingle = only one can be selected\nmultiple = allow multiple selections',
      Markup.inlineKeyboard([
        [Markup.button.callback('single', 'group_type_single')],
        [Markup.button.callback('multiple', 'group_type_multiple')]
      ])
    )
  }

  // ─── EDIT TOPPING FLOWS ─────────────────────────────────
  if (flow.step === 'awaiting_topping_new_name') {
    const { error } = await supabase.from('toppings').update({ name: text }).eq('id', flow.toppingId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Topping renamed to "${text}".`)
  }

  if (flow.step === 'awaiting_topping_new_price') {
    const price = parseFloat(text)
    if (isNaN(price) || price < 0) return ctx.reply('❌ Invalid price. Send a number.')
    const { error } = await supabase.from('toppings').update({ price }).eq('id', flow.toppingId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Price updated to ${price.toFixed(2)} IQD.`)
  }

  if (flow.step === 'awaiting_topping_new_tag') {
    const tag = text === '-' ? null : text
    const { error } = await supabase.from('toppings').update({ tag }).eq('id', flow.toppingId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(tag ? `✅ Tag set to "${tag}".` : '✅ Tag removed.')
  }

  // ─── EDIT GROUP FLOWS ───────────────────────────────────
  if (flow.step === 'awaiting_group_new_name') {
    const { error } = await supabase.from('topping_groups').update({ name: text }).eq('id', flow.groupId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Group renamed to "${text}".`)
  }
})

// === NEW === Group type selection via inline callback (since it's a choice, not text)
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

// ═══════════════════════════════════════════════════════════
// ADMIN: MANAGE TOPPINGS
// ═══════════════════════════════════════════════════════════

bot.action('toppings_manage', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()

  const { data: toppings, error } = await supabase
    .from('toppings').select('id, name, price, is_active').order('name')
  if (error) return ctx.reply(`❌ ${error.message}`)
  if (!toppings?.length) return ctx.reply('No toppings yet. Add one first.')

  const buttons = toppings.map(t => [
    // toppin_<UUID> = 7 + 36 = 43 bytes ✅
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

  // tpname_<UUID> = 7 + 36 = 43 bytes ✅
  // tpprice_<UUID> = 8 + 36 = 44 bytes ✅
  // tptag_<UUID> = 6 + 36 = 42 bytes ✅
  // tptoggle_<UUID> = 9 + 36 = 45 bytes ✅
  // tpdel_<UUID> = 6 + 36 = 42 bytes ✅
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

// ═══════════════════════════════════════════════════════════
// ADMIN: MANAGE GROUPS
// ═══════════════════════════════════════════════════════════

bot.action('groups_manage', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()

  const { data: groups, error } = await supabase
    .from('topping_groups').select('id, name, selection_type, required').order('name')
  if (error) return ctx.reply(`❌ ${error.message}`)
  if (!groups?.length) return ctx.reply('No topping groups yet. Add one first.')

  // grpmgr_<UUID> = 7 + 36 = 43 bytes ✅
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

  // grpname_<UUID> = 8 + 36 = 44 bytes ✅
  // grptype_<UUID> = 8 + 36 = 44 bytes ✅
  // grpreq_<UUID>  = 7 + 36 = 43 bytes ✅
  // grpdel_<UUID>  = 7 + 36 = 43 bytes ✅
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
  // Toggle the type
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

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS (Moved to lib/notifications.js)
// ═══════════════════════════════════════════════════════════

// ─── WEBHOOK EXPORT (for Vercel) ─────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const secret = req.headers['x-telegram-bot-api-secret-token']
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    try {
      await bot.handleUpdate(req.body)
      res.status(200).json({ ok: true })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal error' })
    }
  } else {
    res.status(200).json({ status: 'Corner Bot is running 🌽' })
  }
}
