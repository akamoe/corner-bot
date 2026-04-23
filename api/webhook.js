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

// ─── /start ─────────────────────────────────────────────────

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const role = await getStaffRole(ctx.from.id)

  if (role === 'admin') {
    return ctx.reply(
      `👑 Welcome back, Admin!\n\nWhat would you like to manage?`,
      Markup.keyboard([
        ['📋 View Orders', '🍽 Manage Menu'],
        ['👤 Manage Staff', '🕐 Manage Slots'],
        ['📊 Analytics', '📢 Broadcast']
      ]).resize()
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

// Category selected
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

// Add item to cart
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

// Remove item
bot.action(/^remove_(.+)$/, async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  await removeItemFromCart(user.id, ctx.match[1])
  await ctx.answerCbQuery('Item removed.')
  await ctx.deleteMessage()
})

// Clear cart
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

// Slot selected → place order
bot.action(/^slot_(.+)$/, async (ctx) => {
  const slotId = ctx.match[1]
  const user = await getOrCreateUser(ctx.from.id)
  const cart = await getCart(user.id)

  if (!cart || !cart.order_items?.length) {
    return ctx.answerCbQuery('Your cart is empty.')
  }

  await ctx.answerCbQuery()
  const order = await confirmOrder(cart.id, slotId)

  // Get slot label
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

  // Notify cashiers
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

// ─── CASHIER FLOW ────────────────────────────────────────────

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

// Status update by cashier
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

  // Notify the student
  await notifyStudent(bot, order, newStatus)
})

// Look up order by code
bot.hears('🔍 Look Up Order', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.reply('⛔ Unauthorized.')
  await ctx.reply('Enter the order code (e.g. ORD-4A2B1):')
})

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

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  const userId = ctx.from.id

  // ─── ADMIN MULTI-STEP FLOWS ──────────────────────────────────

  const flow = adminFlowState.get(userId)

  if (flow?.step === 'awaiting_cashier_id') {
    if (!/^\d+$/.test(text)) {
      return ctx.reply('❌ Invalid ID. Please send a numeric Telegram ID only.')
    }
    adminFlowState.set(userId, { step: 'awaiting_cashier_username', telegramId: text })
    return ctx.reply(
      '✅ Telegram ID saved.\n\n' +
      'Step 2 of 2: Now send the cashier\'s *username* (without @).',
      { parse_mode: 'Markdown' }
    )
  }

  if (flow?.step === 'awaiting_cashier_username') {
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

    const msg = existing
      ? `✅ Cashier @${username} updated successfully!`
      : `✅ Cashier @${username} added successfully!`

    return ctx.reply(msg)
  }

  if (flow?.step === 'awaiting_remove_id') {
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

  // ─── ORD- ORDER LOOKUP ──────────────────────────────────────

  if (!text.toUpperCase().startsWith('ORD-')) return

  const role = await getStaffRole(ctx.from.id)
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
})

// ─── ADMIN FLOW ──────────────────────────────────────────────

bot.hears('👤 Manage Staff', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

  await ctx.reply(
    '👤 *Staff Management*\n\nChoose an action:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Cashier', 'add_cashier_btn')],
        [Markup.button.callback('🗑 Remove Cashier', 'remove_cashier_btn')]
      ])
    }
  )
})

// Inline button handlers for Manage Staff
bot.action('add_cashier_btn', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')

  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_cashier_id' })
  await ctx.editMessageText(
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
  await ctx.editMessageText(
    '🗑 *Remove Cashier*\n\n' +
    'Please send the cashier\'s *Telegram ID* to remove.',
    { parse_mode: 'Markdown' }
  )
})

bot.command('addcashier', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

  // Start multi-step flow
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

  // Start multi-step flow
  adminFlowState.set(ctx.from.id, { step: 'awaiting_remove_id' })
  await ctx.reply(
    '🗑 *Remove Cashier*\n\n' +
    'Please send the cashier\'s *Telegram ID* to remove.',
    { parse_mode: 'Markdown' }
  )
})

// ─── ADMIN BUTTON HANDLERS (placeholder implementations) ─────

bot.hears('📋 View Orders', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

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

    await ctx.reply(text, { parse_mode: 'Markdown' })
  }
})

bot.hears('🍽 Manage Menu', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
  await ctx.reply('🍽 Menu management coming soon! Use Supabase Dashboard to edit items for now.')
})

bot.hears('🕐 Manage Slots', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
  await ctx.reply('🕐 Slot management coming soon! Use Supabase Dashboard to edit pickup slots for now.')
})

bot.hears('📊 Analytics', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
  await ctx.reply('📊 Analytics dashboard coming soon!')
})

bot.hears('📢 Broadcast', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')
  await ctx.reply('📢 Broadcast feature coming soon!\n\nUsage will be: /broadcast Your message here')
})

// ─── COMMAND ALIASES ────────────────────────────────────────

bot.command('cart', async (ctx) => {
  // Alias for 🛒 My Cart button
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

// ─── HELP BUTTON ────────────────────────────────────────────

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

// ─── NOTIFICATIONS ───────────────────────────────────────────

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

    // Get the user's telegram_id from the users table
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
