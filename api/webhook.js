import 'dotenv/config'
import { Telegraf, Markup } from 'telegraf'
import { getOrCreateUser, getStaffRole, hashTelegramId } from '../lib/auth.js'
import { getCategories, getItemsByCategory, getMenuItem } from '../lib/menu.js'
import { getAvailableSlots } from '../lib/slots.js'
import { getCart, addItemToCart, removeItemFromCart, clearCart } from '../lib/cart.js'
import { confirmOrder, updateOrderStatus, getOrderByCode, getPendingOrders } from '../lib/orders.js'
import supabase from '../lib/supabase.js'

const bot = new Telegraf(process.env.BOT_TOKEN)

// Simple in-memory state for admin multi-step flows
const adminFlowState = new Map()

// Register commands with Telegram so they show in the / menu
bot.telegram.setMyCommands([
  { command: 'start', description: 'Start the bot' },
  { command: 'addcashier', description: 'Add a cashier (admin only)' },
  { command: 'removecashier', description: 'Remove a cashier (admin only)' },
  { command: 'status', description: 'Check your active order' },
  { command: 'cart', description: 'View your cart' },
  { command: 'help', description: 'Show help' }
]).catch(err => console.error('Failed to set commands:', err.message))

// ─── GLOBAL ERROR HANDLER ───────────────────────────────────

bot.catch((err, ctx) => {
  console.error('Telegraf error:', err)
  if (ctx) {
    ctx.reply('Oops, something went wrong. Please try again.').catch(console.error)
  }
})

// ─── HELPERS ────────────────────────────────────────────────

function formatOrderSummary(order, items) {
  const lines = items.map(i => `• ${i.item_name} x${i.quantity} — ${(i.item_price * i.quantity).toFixed(2)} IQD`)
  return lines.join('\n')
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
    ['📊 Analytics', '📢 Broadcast']
  ]).resize()
}

// ─── /start ─────────────────────────────────────────────────

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const role = await getStaffRole(ctx.from.id)

  // Cancel any running admin flow when /start is hit
  adminFlowState.delete(ctx.from.id)

  if (role === 'admin') {
    return ctx.reply(
      `👑 Welcome back, Admin!\n\nWhat would you like to manage?`,
      adminKeyboard()
    )
  }

  if (role === 'cashier') {
    return ctx.reply(
      `👋 Welcome, Cashier!\n\nUse the buttons below to manage incoming orders.`,
      Markup.keyboard([
        ['📋 Active Orders'],
        ['🔍 Look Up Order']
      ]).resize()
    )
  }

  // Regular student
  return ctx.reply(
    `🌽 Welcome to *Corner*!\n\nFresh food, ready when you are. Order ahead and skip the line.`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        ['🍽 Browse Menu', '🛒 My Cart'],
        ['📦 My Orders', '❓ Help']
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_orders_date' })
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
        [Markup.button.callback('➕ Add Category', 'menu_add_category')]
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_item_name', itemId: ctx.match[1] })
  await ctx.reply('✏️ Send the new *name* for this item.', { parse_mode: 'Markdown' })
})

bot.action(/^itemedit_price_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_item_price', itemId: ctx.match[1] })
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_category_rename', categoryId: ctx.match[1] })
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_new_category_name' })
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_new_item_name', categoryId: ctx.match[1] })
  await ctx.reply('➕ Send the *name* of the new item.', { parse_mode: 'Markdown' })
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_cashier_id' })
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_remove_id' })
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_slot_rename', slotId: ctx.match[1] })
  await ctx.reply('✏️ Send the new *label* for this slot (e.g. "12:00 PM").', { parse_mode: 'Markdown' })
})

bot.action(/^slotmax_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_slot_max', slotId: ctx.match[1] })
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_new_slot_label' })
  await ctx.reply('➕ Send the *label* for the new slot (e.g. "12:00 PM").', { parse_mode: 'Markdown' })
})

// ─── ADMIN: BROADCAST ────────────────────────────────────────

bot.hears('📢 Broadcast', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
  adminFlowState.set(ctx.from.id, { step: 'awaiting_broadcast_message' })
  await ctx.reply(
    '📢 *Broadcast*\n\nSend the message you want to send to *all users*.\n\nReply with /cancel to abort.',
    { parse_mode: 'Markdown' }
  )
})

bot.action('broadcast_confirm', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
  await ctx.answerCbQuery()

  const state = adminFlowState.get(ctx.from.id)
  if (!state || state.step !== 'awaiting_broadcast_confirm') {
    return ctx.reply('⚠️ Nothing to broadcast. Tap 📢 Broadcast again.')
  }

  const message = state.message
  adminFlowState.delete(ctx.from.id)

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
  adminFlowState.delete(ctx.from.id)
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
  adminFlowState.set(ctx.from.id, { step: 'awaiting_analytics_days' })
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

bot.hears('🍽 Browse Menu', async (ctx) => {
  const categories = await getCategories()

  if (!categories.length) {
    return ctx.reply('No menu items available right now. Check back soon!')
  }

  const buttons = categories.map(c =>
    [Markup.button.callback(`${c.emoji || '🍴'} ${c.name}`, `cat_${c.id}`)]
  )

  return ctx.reply(
    '📋 *Our Menu*\n\nChoose a category:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    }
  )
})

bot.action(/^cat_(.+)$/, async (ctx) => {
  const categoryId = ctx.match[1]
  const items = await getItemsByCategory(categoryId)

  if (!items.length) {
    return ctx.answerCbQuery('No items in this category right now.')
  }

  await ctx.answerCbQuery()

  for (const item of items) {
    const text = `*${item.name}*\n${item.description || ''}\n\n💰 ${item.price.toFixed(2)} IQD`
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add to Cart', `add_${item.id}`)],
      ])
    })
  }
})

bot.action(/^add_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1]
  const menuItem = await getMenuItem(itemId)

  if (!menuItem) return ctx.answerCbQuery('Item not found.')

  const user = await getOrCreateUser(ctx.from.id)
  await addItemToCart(user.id, menuItem)
  await ctx.answerCbQuery(`✅ ${menuItem.name} added to cart!`)
})

// ─── CART ────────────────────────────────────────────────────

bot.hears('🛒 My Cart', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const cart = await getCart(user.id)

  if (!cart || !cart.order_items?.length) {
    return ctx.reply(
      '🛒 Your cart is empty.\n\nBrowse the menu to add items!',
      Markup.keyboard([
        ['🍽 Browse Menu', '🛒 My Cart'],
        ['📦 My Orders', '❓ Help']
      ]).resize()
    )
  }

  const items = cart.order_items
  const total = items.reduce((s, i) => s + i.item_price * i.quantity, 0)
  const summary = formatOrderSummary(cart, items)

  const removeButtons = items.map(i => [
    Markup.button.callback(`❌ Remove ${i.item_name}`, `remove_${i.id}`)
  ])

  await ctx.reply(
    `🛒 *Your Cart*\n\n${summary}\n\n*Total: ${total.toFixed(2)} IQD*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...removeButtons,
        [Markup.button.callback('✅ Confirm Order', 'confirm_order')],
        [Markup.button.callback('🗑 Clear Cart', 'clear_cart')]
      ])
    }
  )
})

bot.action(/^remove_(.+)$/, async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  await removeItemFromCart(user.id, ctx.match[1])
  await ctx.answerCbQuery('Item removed.')
  await ctx.deleteMessage()
})

bot.action('clear_cart', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  await clearCart(user.id)
  await ctx.answerCbQuery('Cart cleared.')
  await ctx.editMessageText('🗑 Your cart has been cleared.')
})

// ─── CONFIRM ORDER → PICK SLOT ───────────────────────────────

bot.action('confirm_order', async (ctx) => {
  await ctx.answerCbQuery()
  const slots = await getAvailableSlots()

  if (!slots.length) {
    return ctx.reply('⚠️ No pickup slots available right now. Please try again later.')
  }

  const buttons = slots.map(s => [
    Markup.button.callback(
      `🕐 ${s.label} — ${s.spots_left} spot${s.spots_left !== 1 ? 's' : ''} left`,
      `slot_${s.id}`
    )
  ])

  await ctx.reply(
    '📅 *Choose a pickup time:*',
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
    return ctx.answerCbQuery('Your cart is empty.')
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
    `✅ *Order Confirmed!*\n\n` +
    `🎫 Your Order Code: *${order.order_code}*\n` +
    `🕐 Pickup Time: *${slot?.label || 'N/A'}*\n\n` +
    `Show this code at the counter when you arrive.\n` +
    `You'll get a notification when your order is ready!`,
    { parse_mode: 'Markdown' }
  )

  await notifyCashiers(bot, order)
})

// ─── MY ORDERS ───────────────────────────────────────────────

bot.hears('📦 My Orders', async (ctx) => {
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
    return ctx.reply('⚠️ Could not load your orders. Please try again.')
  }

  if (!orders?.length) {
    return ctx.reply('You have no past orders yet.')
  }

  const statusEmoji = {
    confirmed: '✅',
    preparing: '👨‍🍳',
    ready: '🔔',
    picked_up: '✔️',
    cancelled: '❌'
  }

  const text = orders.map(o =>
    `${statusEmoji[o.status] || '•'} *${o.order_code}* — ${o.status.toUpperCase()}\n` +
    `🕐 ${o.pickup_slots?.label || 'N/A'} | 💰 ${o.total_amount?.toFixed(2)} IQD`
  ).join('\n\n')

  await ctx.reply(`📦 *Your Recent Orders*\n\n${text}`, { parse_mode: 'Markdown' })
})

// ═══════════════════════════════════════════════════════════
// CASHIER HANDLERS
// ═══════════════════════════════════════════════════════════

bot.hears('📋 Active Orders', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.reply('⛔ Unauthorized.')

  const orders = await getPendingOrders()

  if (!orders.length) {
    return ctx.reply('✅ No active orders right now.')
  }

  for (const order of orders) {
    const items = order.order_items.map(i => `• ${i.item_name} x${i.quantity}`).join('\n')
    const text =
      `🎫 *${order.order_code}*\n` +
      `👤 Token: ${order.users?.anonymous_token}\n` +
      `🕐 Pickup: ${order.pickup_slots?.label}\n` +
      `📋 Status: ${order.status.toUpperCase()}\n\n` +
      `${items}`

    const buttons = []
    if (order.status === 'confirmed') {
      buttons.push([Markup.button.callback('👨‍🍳 Mark Preparing', `status_${order.id}_preparing`)])
    }
    if (order.status === 'preparing') {
      buttons.push([Markup.button.callback('🔔 Mark Ready', `status_${order.id}_ready`)])
    }
    if (order.status === 'ready') {
      buttons.push([Markup.button.callback('✔️ Mark Picked Up', `status_${order.id}_picked_up`)])
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    })
  }
})

bot.action(/^status_(.+)_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.answerCbQuery('Unauthorized.')

  const orderId = ctx.match[1]
  const newStatus = ctx.match[2]

  const order = await updateOrderStatus(orderId, newStatus)
  await ctx.answerCbQuery(`Order marked as ${newStatus}`)
  await ctx.editMessageText(
    ctx.callbackQuery.message.text + `\n\n✅ Updated to: *${newStatus.toUpperCase()}*`,
    { parse_mode: 'Markdown' }
  )

  await notifyStudent(bot, order, newStatus)
})

bot.hears('🔍 Look Up Order', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.reply('⛔ Unauthorized.')
  await ctx.reply('Enter the order code (e.g. ORD-4A2B1):')
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
    return ctx.reply('⚠️ Could not load your order. Please try again.')
  }

  if (!order) return ctx.reply('You have no active orders right now.')

  const statusEmoji = {
    confirmed: '✅ Confirmed — waiting to be prepared',
    preparing: '👨‍🍳 Being prepared now!',
    ready: '🔔 READY — come pick it up!'
  }

  await ctx.reply(
    `📦 *Order ${order.order_code}*\n\n` +
    `${statusEmoji[order.status]}\n` +
    `🕐 Pickup slot: ${order.pickup_slots?.label}`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('cancel', async (ctx) => {
  if (adminFlowState.has(ctx.from.id)) {
    adminFlowState.delete(ctx.from.id)
    return ctx.reply('❌ Cancelled.')
  }
  return ctx.reply('Nothing to cancel.')
})

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

bot.command('cart', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const cart = await getCart(user.id)

  if (!cart || !cart.order_items?.length) {
    return ctx.reply('🛒 Your cart is empty.\n\nBrowse the menu to add items!')
  }

  const items = cart.order_items
  const total = items.reduce((s, i) => s + i.item_price * i.quantity, 0)
  const summary = formatOrderSummary(cart, items)

  await ctx.reply(
    `🛒 *Your Cart*\n\n${summary}\n\n*Total: ${total.toFixed(2)} IQD*`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('help', async (ctx) => {
  await ctx.reply(
    `*Corner Bot Help*\n\n` +
    `🍽 *Browse Menu* — See today's available items\n` +
    `🛒 *My Cart* — View and manage your cart\n` +
    `📦 *My Orders* — Track your order status\n\n` +
    `After placing an order you'll receive a *4-digit code*. Show it at the counter at your chosen pickup time.\n\n` +
    `Questions? Visit us at the Corner container on campus! 🌽`,
    { parse_mode: 'Markdown' }
  )
})

bot.hears('❓ Help', async (ctx) => {
  await ctx.reply(
    `*Corner Bot Help*\n\n` +
    `🍽 *Browse Menu* — See today's available items\n` +
    `🛒 *My Cart* — View and manage your cart\n` +
    `📦 *My Orders* — Track your order status\n\n` +
    `After placing an order you'll receive a *4-digit code*. Show it at the counter at your chosen pickup time.\n\n` +
    `Questions? Visit us at the Corner container on campus! 🌽`,
    { parse_mode: 'Markdown' }
  )
})

// ═══════════════════════════════════════════════════════════
// TEXT HANDLER — must be registered LAST so bot.hears() work
// ═══════════════════════════════════════════════════════════

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  const userId = ctx.from.id
  const flow = adminFlowState.get(userId)

  // ─── CASHIER FLOWS ──────────────────────────────────────
  if (!flow) {
    // ORD- lookup (staff only)
    if (text.toUpperCase().startsWith('ORD-')) {
      const role = await getStaffRole(userId)
      if (!role) return
      const order = await getOrderByCode(text)
      if (!order) return ctx.reply('❌ Order not found.')
      const items = order.order_items.map(i => `• ${i.item_name} x${i.quantity}`).join('\n')
      return ctx.reply(
        `🎫 *${order.order_code}*\n` +
        `🕐 Pickup: ${order.pickup_slots?.label}\n` +
        `📋 Status: ${order.status.toUpperCase()}\n\n` +
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
    adminFlowState.set(userId, { step: 'awaiting_cashier_username', telegramId: text })
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

    adminFlowState.delete(userId)

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
      adminFlowState.delete(userId)
      return ctx.reply('❌ Invalid ID. Please send a numeric Telegram ID only.')
    }
    const hash = hashTelegramId(text)
    const { error } = await supabase.from('staff').update({ is_active: false }).eq('telegram_hash', hash)
    adminFlowState.delete(userId)
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
    adminFlowState.delete(userId)
    return showOrdersForDay(ctx, text)
  }

  // ─── MENU FLOWS ─────────────────────────────────────────
  if (flow.step === 'awaiting_item_name') {
    const { error } = await supabase.from('menu_items').update({ name: text }).eq('id', flow.itemId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ Item name updated.')
  }

  if (flow.step === 'awaiting_item_price') {
    const price = parseFloat(text)
    if (isNaN(price) || price < 0) return ctx.reply('❌ Invalid price. Send a number.')
    const { error } = await supabase.from('menu_items').update({ price }).eq('id', flow.itemId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Price updated to ${price.toFixed(2)} IQD.`)
  }

  if (flow.step === 'awaiting_category_rename') {
    const { error } = await supabase.from('categories').update({ name: text }).eq('id', flow.categoryId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ Category renamed.')
  }

  if (flow.step === 'awaiting_new_category_name') {
    // split optional leading emoji + name
    const match = text.match(/^(\p{Extended_Pictographic})\s*(.+)$/u)
    const emoji = match ? match[1] : null
    const name = match ? match[2] : text
    const { error } = await supabase.from('categories').insert({ name, emoji, is_active: true, sort_order: 999 })
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Category "${name}" added.`)
  }

  if (flow.step === 'awaiting_new_item_name') {
    adminFlowState.set(userId, { step: 'awaiting_new_item_price', categoryId: flow.categoryId, name: text })
    return ctx.reply('💲 Now send the *price* (numbers only).', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_item_price') {
    const price = parseFloat(text)
    if (isNaN(price) || price < 0) return ctx.reply('❌ Invalid price. Send a number.')
    adminFlowState.set(userId, { step: 'awaiting_new_item_description', categoryId: flow.categoryId, name: flow.name, price })
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
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Item "${flow.name}" added.`)
  }

  // ─── SLOT FLOWS ─────────────────────────────────────────
  if (flow.step === 'awaiting_slot_rename') {
    const { error } = await supabase.from('pickup_slots').update({ label: text }).eq('id', flow.slotId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ Slot renamed.')
  }

  if (flow.step === 'awaiting_slot_max') {
    const n = parseInt(text, 10)
    if (isNaN(n) || n < 1) return ctx.reply('❌ Send a positive integer.')
    const { error } = await supabase.from('pickup_slots').update({ max_orders: n }).eq('id', flow.slotId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Max orders set to ${n}.`)
  }

  if (flow.step === 'awaiting_new_slot_label') {
    adminFlowState.set(userId, { step: 'awaiting_new_slot_time', label: text })
    return ctx.reply('🕐 Send the *time* for this slot in HH:MM format (24h, e.g. "12:00").', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_slot_time') {
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
      return ctx.reply('❌ Invalid time. Use HH:MM (e.g. 12:00).')
    }
    const slotTime = text.length === 5 ? `${text}:00` : text
    adminFlowState.set(userId, { step: 'awaiting_new_slot_max', label: flow.label, slot_time: slotTime })
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
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Slot "${flow.label}" added.`)
  }

  // ─── BROADCAST FLOW ─────────────────────────────────────
  if (flow.step === 'awaiting_broadcast_message') {
    adminFlowState.set(userId, { step: 'awaiting_broadcast_confirm', message: text })
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
    adminFlowState.delete(userId)
    return showAnalytics(ctx, n)
  }
})

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════

async function notifyCashiers(bot, order) {
  try {
    const { data: cashiers, error } = await supabase
      .from('staff')
      .select('telegram_id')
      .eq('role', 'cashier')
      .eq('is_active', true)

    if (error) {
      console.error('Error fetching cashiers:', error.message)
      return
    }

    if (!cashiers?.length) return

    const { data: orderDetails } = await supabase
      .from('orders')
      .select('*, order_items(*), pickup_slots(label)')
      .eq('id', order.id)
      .single()

    const items = orderDetails?.order_items?.map(i => `• ${i.item_name} x${i.quantity}`).join('\n') || ''
    const message =
      `🔔 *New Order!*\n\n` +
      `🎫 *${order.order_code}*\n` +
      `🕐 Pickup: ${orderDetails?.pickup_slots?.label || 'N/A'}\n` +
      `💰 ${order.total_amount?.toFixed(2)} IQD\n\n` +
      `${items}`

    for (const cashier of cashiers) {
      if (cashier.telegram_id) {
        await bot.telegram.sendMessage(cashier.telegram_id, message, { parse_mode: 'Markdown' })
          .catch(err => console.error(`Failed to notify cashier ${cashier.telegram_id}:`, err.message))
      }
    }
  } catch (err) {
    console.error('Error in notifyCashiers:', err.message)
  }
}

async function notifyStudent(bot, order, status) {
  try {
    const messages = {
      preparing: '👨‍🍳 Your order is being prepared!',
      ready: `🔔 Your order *${order.order_code}* is READY for pickup! Head over now. 🌽`,
      cancelled: `❌ Your order *${order.order_code}* was cancelled. Please contact us.`
    }

    const msg = messages[status]
    if (!msg) return

    const { data: userData, error } = await supabase
      .from('users')
      .select('telegram_id')
      .eq('id', order.user_id)
      .maybeSingle()

    if (error) {
      console.error('Error fetching user for notification:', error.message)
      return
    }

    if (userData?.telegram_id) {
      await bot.telegram.sendMessage(userData.telegram_id, msg, { parse_mode: 'Markdown' })
        .catch(err => console.error(`Failed to notify student ${userData.telegram_id}:`, err.message))
    }
  } catch (err) {
    console.error('Error in notifyStudent:', err.message)
  }
}

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
