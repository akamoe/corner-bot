import 'dotenv/config'
import { Telegraf, Markup } from 'telegraf'
import { getOrCreateUser, getStaffRole, hashTelegramId } from '../lib/auth.js'
import { addItemToCart, removeItemFromCart, getCart } from '../lib/cart.js'
import { getOrderByCode } from '../lib/orders.js'
import { requireAdmin } from '../lib/middleware.js'
import { adminFlowState, orderFlowState } from '../lib/state.js'
import { setupAdminCommands } from '../lib/admin-commands.js'
import { setupAdminOrders } from '../lib/handlers/admin-orders.js'
import { setupAdminMenu } from '../lib/handlers/admin-menu.js'
import { setupAdminStaff } from '../lib/handlers/admin-staff.js'
import { setupAdminSlots } from '../lib/handlers/admin-slots.js'
import { setupAdminBroadcast } from '../lib/handlers/admin-broadcast.js'
import { setupStudentMenu } from '../lib/handlers/student-menu.js'
import { setupStudentCart } from '../lib/handlers/student-cart.js'
import { setupStudentOrders } from '../lib/handlers/student-orders.js'
import { setupCashierOrders } from '../lib/handlers/cashier-orders.js'
import { setupToppingsGroupsManage } from '../lib/handlers/toppings-groups-manage.js'
import { formatOrderSummary } from '../lib/handlers/helpers.js'
import { showOrdersForDay, showAnalytics } from '../lib/handlers/admin-orders.js'
import supabase from '../lib/supabase.js'

const bot = new Telegraf(process.env.BOT_TOKEN)

// ─── DOMAIN HANDLER SETUP (order matters — specific before general) ──

setupAdminCommands(bot)
setupAdminOrders(bot)
setupAdminMenu(bot)
setupAdminStaff(bot)
setupAdminSlots(bot)
setupAdminBroadcast(bot)
setupStudentMenu(bot)
setupStudentCart(bot)
setupStudentOrders(bot)
setupCashierOrders(bot)
setupToppingsGroupsManage(bot)

// ─── REGISTER COMMANDS ────────────────────────────────────────

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
  ]).catch(err => console.error('[setup_commands] Failed to set commands:', err.message, err))
  ctx.reply('Commands updated successfully.')
})

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────

bot.catch((err, ctx) => {
  const ctxInfo = ctx
    ? `userId=${ctx.from?.id} chatId=${ctx.chat?.id}`
    : 'no ctx'
  console.error(`[webhook:bot.catch] ${ctxInfo}:`, err?.stack || err)
  if (ctx) {
    ctx.reply('⚠️ صار خطأ غير متوقع. حاول مرة ثانية.\nإذا استمرت المشكلة، تواصل مع الإدارة.')
      .catch(e => console.error('[webhook] Failed to send error reply:', e.message))
  }
})

// ─── /start ──────────────────────────────────────────────────

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const role = await getStaffRole(ctx.from.id)

  await adminFlowState.delete(ctx.from.id)
  await orderFlowState.delete(ctx.from.id)

  if (role === 'admin') {
    return ctx.reply(
      `👑 Welcome back, Admin!\n\nWhat would you like to manage?`,
      Markup.keyboard([
        ['📋 View Orders', '🍽 Manage Menu'],
        ['👤 Manage Staff', '🕐 Manage Slots'],
        ['📊 Analytics', '📢 Broadcast'],
        ['🧹 Clear Chat']
      ]).resize()
    )
  }

  if (role === 'cashier') {
    return ctx.reply(
      '👋 أهلاً بالكاشير!\n\nاستخدم الأزرار أدناه لإدارة الطلبات الواردة.',
      Markup.keyboard([
        ['📋 الطلبات النشطة'],
        ['🔍 البحث عن طلب']
      ]).resize()
    )
  }

  return ctx.reply(
    '🌽 أهلاً بيك بـ *Corner*!\n\nأكل طازج يجهز لك بوقته. اطلب مسبقاً وما تنطر.',
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        ['🍽 تصفح المنيو', '🛒 سلتي'],
        ['📦 طلباتي', '❓ مساعدة']
      ]).resize()
    }
  )
})

// ─── COMMANDS ─────────────────────────────────────────────────

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
    console.error('[webhook:/status] userId:', ctx.from.id, error.message, error)
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
  const summary = formatOrderSummary(items)

  await ctx.reply(
    `🛒 *سلتك*\n\n${summary}\n\n*المجموع: ${total.toFixed(2)} IQD*`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('help', async (ctx) => {
  await ctx.reply(
    '*مساعدة - Corner Bot*\n\n' +
    '🍽 *تصفح المنيو* — شوف الوجبات المتاحة اليوم\n' +
    '🛒 *سلتي* — شوف وادر سلتك\n' +
    '📦 *طلباتي* — تابع حالة طلبك\n\n' +
    'بعد ما تطلب راح تجيك *رمز*. وريه عند الكاونتر بوقت الاستلام.\n\n' +
    'عندك أسئلة؟ زورنا بـ Corner بالحرم الجامعي! 🌽',
    { parse_mode: 'Markdown' }
  )
})

bot.hears(['❓ مساعدة', '❓ Help'], async (ctx) => {
  await ctx.reply(
    '*مساعدة - Corner Bot*\n\n' +
    '🍽 *تصفح المنيو* — شوف الوجبات المتاحة اليوم\n' +
    '🛒 *سلتي* — شوف وادر سلتك\n' +
    '📦 *طلباتي* — تابع حالة طلبك\n\n' +
    'بعد ما تطلب راح تجيك *رمز*. وريه عند الكاونتر بوقت الاستلام.\n\n' +
    'عندك أسئلة؟ زورنا بـ Corner بالحرم الجامعي! 🌽',
    { parse_mode: 'Markdown' }
  )
})

// ─── ADMIN: CLEAR CHAT ────────────────────────────────────────

bot.hears('🧹 Clear Chat', requireAdmin, async (ctx) => {
  const currentMsgId = ctx.message.message_id
  const chatId = ctx.chat.id

  const ids = Array.from({ length: 80 }, (_, i) => currentMsgId - i)
  await Promise.all(ids.map(id => ctx.telegram.deleteMessage(chatId, id).catch(() => {})))
})

// ─── LEGACY remove_ handler ──────────────────────────────────

bot.action(/^remove_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  await removeItemFromCart(user.id, ctx.match[1])
  await ctx.answerCbQuery('تم الحذف.')
  await ctx.deleteMessage()
})

// ════════════════════════════════════════════════════════════
// TEXT HANDLER — must be registered LAST
// ════════════════════════════════════════════════════════════

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  const userId = ctx.from.id
  const flow = await adminFlowState.get(userId)

  // ─── CASHIER FLOWS ─────────────────────────────────────────

  if (!flow) {
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

  // ─── STAFF: ADD CASHIER ────────────────────────────────────

  if (flow.step === 'awaiting_cashier_id') {
    if (!/^\d+$/.test(text)) {
      return ctx.reply('❌ Invalid ID. Please send a numeric Telegram ID only.')
    }
    await adminFlowState.set(userId, { step: 'awaiting_cashier_username', telegramId: text })
    return ctx.reply(
      "✅ Telegram ID saved.\n\nStep 2 of 2: Now send the cashier's *username* (without @).",
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
      console.error('[webhook:add_cashier] telegramId:', telegramId, error.message, error)
      return ctx.reply('❌ Failed to add cashier. Please try again.')
    }

    return ctx.reply(existing
      ? `✅ Cashier @${username} updated successfully!`
      : `✅ Cashier @${username} added successfully!`)
  }

  if (flow.step === 'awaiting_remove_id') {
    if (!/^\\d+$/.test(text)) {
      await adminFlowState.delete(userId)
      return ctx.reply('❌ Invalid ID. Please send a numeric Telegram ID only.')
    }
    const hash = hashTelegramId(text)
    const { error } = await supabase.from('staff').update({ is_active: false }).eq('telegram_hash', hash)
    await adminFlowState.delete(userId)
    if (error) {
      console.error('[webhook:remove_cashier] hash:', hash, error.message, error)
      return ctx.reply('❌ Failed to remove cashier.')
    }
    return ctx.reply('✅ Cashier removed.')
  }

  // ─── VIEW ORDERS: CUSTOM DATE ─────────────────────────────

  if (flow.step === 'awaiting_orders_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return ctx.reply('❌ Invalid format. Use YYYY-MM-DD.')
    }
    await adminFlowState.delete(userId)
    return showOrdersForDay(ctx, text)
  }

  // ─── MENU FLOWS ───────────────────────────────────────────

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

  // ─── SLOT FLOWS ───────────────────────────────────────────

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

  // ─── BROADCAST FLOW ───────────────────────────────────────

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

  // ─── ANALYTICS CUSTOM DAYS ────────────────────────────────

  if (flow.step === 'awaiting_analytics_days') {
    const n = parseInt(text, 10)
    if (isNaN(n) || n < 1 || n > 365) return ctx.reply('❌ Send a number between 1 and 365.')
    await adminFlowState.delete(userId)
    return showAnalytics(ctx, n)
  }

  // ─── TOPPING FLOWS ────────────────────────────────────────

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

  // ─── GROUP FLOWS ──────────────────────────────────────────

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

  // ─── EDIT TOPPING FLOWS ───────────────────────────────────

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

  // ─── EDIT GROUP FLOWS ─────────────────────────────────────

  if (flow.step === 'awaiting_group_new_name') {
    const { error } = await supabase.from('topping_groups').update({ name: text }).eq('id', flow.groupId)
    await adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ Group renamed to "${text}".`)
  }
})

// ════════════════════════════════════════════════════════════
// WEBHOOK EXPORT (for Vercel)
// ════════════════════════════════════════════════════════════

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
      console.error('[webhook:handler] Error handling update:', err?.stack || err)
      res.status(500).json({ error: 'Internal error' })
    }
  } else {
    res.status(200).json({ status: 'Corner Bot is running 🌽' })
  }
}
