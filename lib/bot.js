/**
 * Bot assembly.
 *
 * Everything that used to live in `api/webhook.js` lives here so that:
 *   - `api/webhook.js` is a thin Vercel entry point
 *   - `scripts/dev.js` can launch the very same bot for local testing
 *   - tests can import and drive it without an HTTP server
 *
 * Registration order matters: specific handlers first, catch-all `bot.on('text')`
 * last (see SKILL.md §2).
 */

import { Telegraf, Markup } from 'telegraf'
import { getOrCreateUser, getStaffRole, hashTelegramId } from './auth.js'
import { removeItemFromCart } from './cart.js'
import { getActiveOrderForUser } from './orders.js'
import { latestPaymentForUser, waylConfig } from './wayl.js'
import { safeCheckoutUrl } from './wayl-core.js'
import { requireAdmin } from './middleware.js'
import { adminFlowState, orderFlowState, deleteStaleStates } from './state.js'
import supabase from './supabase.js'

import { setupAdminCommands } from './admin-commands.js'
import { setupAdminOrders, showOrdersForDay, showAnalytics } from './handlers/admin-orders.js'
import { setupAdminMenu } from './handlers/admin-menu.js'
import { setupAdminStaff } from './handlers/admin-staff.js'
import { setupAdminSlots } from './handlers/admin-slots.js'
import { setupAdminBroadcast } from './handlers/admin-broadcast.js'
import { setupStudentMenu, showCategories } from './handlers/student-menu.js'
import { setupStudentCart, showCart } from './handlers/student-cart.js'
import { setupStudentOrders, showMyOrders } from './handlers/student-orders.js'
import { setupCashierOrders } from './handlers/cashier-orders.js'
import { setupToppingsGroupsManage } from './handlers/toppings-groups-manage.js'
import {
  adminKeyboard,
  cashierKeyboard,
  studentKeyboard,
  studentOrderCard,
  safeReply
} from './handlers/helpers.js'

export const COMMANDS = [
  { command: 'start', description: 'البداية / Start' },
  { command: 'menu', description: 'تصفح المنيو' },
  { command: 'cart', description: 'سلتي' },
  { command: 'status', description: 'حالة طلبي' },
  { command: 'help', description: 'مساعدة' },
  { command: 'cancel', description: 'إلغاء العملية الحالية' }
]

export function createBot(token = process.env.BOT_TOKEN, options = undefined) {
  if (!token) {
    throw new Error('BOT_TOKEN is not set — the bot cannot start')
  }

  const bot = new Telegraf(token, options)

  // ─── DOMAIN HANDLERS (order matters) ─────────────────────────
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

  // ─── GLOBAL ERROR HANDLER ────────────────────────────────────

  bot.catch((err, ctx) => {
    const info = ctx ? `userId=${ctx.from?.id} chatId=${ctx.chat?.id}` : 'no ctx'
    console.error(`[bot.catch] ${info}:`, err?.stack || err)
    ctx
      ?.reply('⚠️ صار خطأ غير متوقع. جرب مرة ثانية.\nاذا استمرت المشكلة كلم الإدارة.')
      .catch((e) => console.error('[bot.catch] failed to reply:', e.message))
  })

  // ─── /start ──────────────────────────────────────────────────

  bot.start(async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    await adminFlowState.delete(ctx.from.id)
    await orderFlowState.delete(ctx.from.id)

    if (role === 'admin') {
      return ctx.reply('👑 أهلاً بالإدارة!\n\nشنو تريد تدير؟', adminKeyboard())
    }

    if (role === 'cashier') {
      return ctx.reply(
        '👋 أهلاً بالكاشير!\n\nمن هنا تدير الطلبات الواردة.',
        cashierKeyboard()
      )
    }

    return ctx.reply(
      '🌽 أهلاً بيك بـ *Corner*!\n\n' +
        'اطلب مسبقاً وما تنطر — نجهزه بأعلى طعم.\n\n' +
        'اختار من الأزرار تحت 👇',
      { parse_mode: 'Markdown', ...studentKeyboard() }
    )
  })

  // ─── COMMANDS ────────────────────────────────────────────────

  bot.command('status', async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const order = await getActiveOrderForUser(user.id)

    if (!order) {
      const payment = await latestPaymentForUser(user.id)
      if (payment?.status === 'pending') {
        const rows = []
        if (waylConfig() && payment.checkout_url) {
          try { rows.push([Markup.button.url('🔗 افتح رابط الدفع', safeCheckoutUrl(payment.checkout_url))]) }
          catch { /* Never show an untrusted URL. */ }
        }
        rows.push([Markup.button.callback('🔄 تحقق من الدفع', 'wayl_status')])
        return safeReply(ctx,
          `⏳ الدفع بعده قيد الانتظار.\n🕐 الاستلام: ${payment.pickup_slots?.label || 'الوقت المختار'}` +
          '\nالطلب ما وصل للمطبخ بعد.',
          { ...Markup.inlineKeyboard(rows) })
      }
      if (payment?.status === 'paid' && payment.environment === 'test') {
        return safeReply(ctx, '🧪 الدفع التجريبي تأكد. ما انرسل طلب للمطبخ.')
      }
      return safeReply(
        ctx,
        '📦 ما عندك طلب نشط هسة.\n\nتصفح المنيو واطلب 🌽',
        { ...Markup.inlineKeyboard([[Markup.button.callback('🍽 تصفح المنيو', 'catroot')]]) }
      )
    }

    const payment = await latestPaymentForUser(user.id)
    const paymentLine = payment?.cart_id === order.id && payment.status === 'refunded'
      ? '\n\n↩️ حالة الدفع: المبلغ انرجع. كلمنا بالكاونتر عن حالة الطلب.'
      : payment?.cart_id === order.id && payment.status === 'paid'
        ? '\n\n💳 حالة الدفع: تأكد.' : ''
    return safeReply(ctx, `${studentOrderCard(order)}${paymentLine}`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 تحديث الحالة', 'my_orders')],
        [Markup.button.callback('🍽 تصفح المنيو', 'catroot')]
      ])
    })
  })

  bot.command('menu', async (ctx) => {
    await showCategories(ctx)
  })

  bot.command('cart', async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    await showCart(ctx, user.id, ctx.from.id)
  })

  bot.command('help', async (ctx) => {
    await safeReply(ctx, helpText())
  })

  bot.hears(['❓ مساعدة', '❓ Help'], async (ctx) => {
    await safeReply(ctx, helpText())
  })

  bot.command('cancel', async (ctx) => {
    const hadAdmin = await adminFlowState.has(ctx.from.id)
    const hadOrder = await orderFlowState.has(ctx.from.id)
    await adminFlowState.delete(ctx.from.id)
    await orderFlowState.delete(ctx.from.id)
    return ctx.reply(hadAdmin || hadOrder ? '❌ ألغينا العملية الحالية.' : 'ماكو شي نلغيه.')
  })

  // ─── ADMIN: HOUSEKEEPING ─────────────────────────────────────

  bot.command('setup_commands', requireAdmin, async (ctx) => {
    await bot.telegram
      .setMyCommands(COMMANDS)
      .catch((err) => console.error('[setup_commands] failed:', err.message, err))
    await ctx.reply('✅ تم تحديث قائمة الأوامر.')
  })

  bot.command('cleanup_state', requireAdmin, async (ctx) => {
    const removed = await deleteStaleStates(30)
    await ctx.reply(`🧹 انحذف ${removed} سجل حالة قديم (أكثر من 30 يوم).`)
  })

  bot.hears('🧹 Clear Chat', requireAdmin, async (ctx) => {
    const currentMsgId = ctx.message.message_id
    const chatId = ctx.chat.id
    const ids = Array.from({ length: 80 }, (_, i) => currentMsgId - i)
    await Promise.all(ids.map((id) => ctx.telegram.deleteMessage(chatId, id).catch(() => {})))
  })

  // ─── LEGACY CART BUTTON (old messages still in students' chats) ──

  bot.action(/^remove_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    await removeItemFromCart(user.id, ctx.match[1])
    await ctx.answerCbQuery('انشال من السلة.').catch(() => {})
    await ctx.deleteMessage().catch(() => {})
  })

  // ════════════════════════════════════════════════════════════
  // TEXT HANDLER — registered LAST
  // ════════════════════════════════════════════════════════════

  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim()
    const userId = ctx.from.id
    const flow = await adminFlowState.get(userId)

    if (!flow) {
      // Nobody has a pending form. Point people back to the buttons instead of
      // silently ignoring them (the old behaviour was a dead end).
      if (text.startsWith('/')) return

      const role = await getStaffRole(userId)
      if (role === 'admin') {
        return ctx.reply('🤔 ما فهمت. اختار من الأزرار 👇', adminKeyboard())
      }
      if (role === 'cashier') {
        return ctx.reply(
          '🔍 اذا تدور على طلب ابعث رمزه (مثل ORD-7KQ2M)، أو اختار من الأزرار 👇',
          cashierKeyboard()
        )
      }
      return ctx.reply('🤔 ما فهمت عليك.\n\nاختار من الأزرار تحت 👇', studentKeyboard())
    }

    // ─── STAFF: ADD CASHIER ────────────────────────────────────

    if (flow.step === 'awaiting_cashier_id') {
      if (!/^\d+$/.test(text)) {
        return ctx.reply('❌ لازم ترسل رقم Telegram ID (أرقام بس).')
      }
      await adminFlowState.set(userId, { step: 'awaiting_cashier_username', telegramId: text })
      return ctx.reply('✅ سجلنا الـ ID.\n\nالخطوة 2: ارسل *يوزر* الكاشير (بدون @).', {
        parse_mode: 'Markdown'
      })
    }

    if (flow.step === 'awaiting_cashier_username') {
      const { telegramId } = flow
      const username = text.replace(/^@/, '')
      const hash = hashTelegramId(telegramId)

      const { data: existing } = await supabase
        .from('staff')
        .select('id')
        .eq('telegram_hash', hash)
        .maybeSingle()

      const { error } = await supabase.from('staff').upsert(
        {
          telegram_hash: hash,
          telegram_id: String(telegramId),
          telegram_username: username,
          role: 'cashier',
          is_active: true
        },
        { onConflict: 'telegram_hash' }
      )

      await adminFlowState.delete(userId)

      if (error) {
        console.error('[bot:add_cashier] telegramId:', telegramId, error.message, error)
        return ctx.reply('❌ ما قدرنا نضيف الكاشير. جرب ثاني.')
      }

      return ctx.reply(
        existing
          ? `✅ تحدثنا الكاشير @${username}.`
          : `✅ انضاف الكاشير @${username}.`
      )
    }

    if (flow.step === 'awaiting_remove_id') {
      if (!/^\d+$/.test(text)) {
        await adminFlowState.delete(userId)
        return ctx.reply('❌ لازم ترسل رقم Telegram ID (أرقام بس).')
      }
      const hash = hashTelegramId(text)
      const { error } = await supabase.from('staff').update({ is_active: false }).eq('telegram_hash', hash)
      await adminFlowState.delete(userId)
      if (error) {
        console.error('[bot:remove_cashier] hash:', hash, error.message, error)
        return ctx.reply('❌ ما قدرنا نشيل الكاشير.')
      }
      return ctx.reply('✅ انشال الكاشير.')
    }

    // ─── VIEW ORDERS: CUSTOM DATE ─────────────────────────────

    if (flow.step === 'awaiting_orders_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return ctx.reply('❌ الصيغة غلط. استخدم YYYY-MM-DD.')
      }
      await adminFlowState.delete(userId)
      return showOrdersForDay(ctx, text)
    }

    // ─── MENU FLOWS ───────────────────────────────────────────

    if (flow.step === 'awaiting_item_name') {
      const { error } = await supabase.from('menu_items').update({ name: text }).eq('id', flow.itemId)
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply('✅ تحدث اسم الوجبة.')
    }

    if (flow.step === 'awaiting_item_price') {
      const price = parseFloat(text)
      if (isNaN(price) || price < 0) return ctx.reply('❌ السعر غلط. ارسل رقم.')
      const { error } = await supabase.from('menu_items').update({ price }).eq('id', flow.itemId)
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply(`✅ تحدث السعر إلى ${price}.`)
    }

    if (flow.step === 'awaiting_category_rename') {
      const { error } = await supabase.from('categories').update({ name: text }).eq('id', flow.categoryId)
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply('✅ تحدث اسم الفئة.')
    }

    if (flow.step === 'awaiting_new_category_name') {
      const match = text.match(/^(\p{Extended_Pictographic})\s*(.+)$/u)
      const emoji = match ? match[1] : null
      const name = match ? match[2] : text
      const { error } = await supabase
        .from('categories')
        .insert({ name, emoji, is_active: true, sort_order: 999 })
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply(`✅ انضافت الفئة "${name}".`)
    }

    if (flow.step === 'awaiting_new_item_name') {
      await adminFlowState.set(userId, {
        step: 'awaiting_new_item_price',
        categoryId: flow.categoryId,
        name: text
      })
      return ctx.reply('💲 ارسل *السعر* (أرقام بس).', { parse_mode: 'Markdown' })
    }

    if (flow.step === 'awaiting_new_item_price') {
      const price = parseFloat(text)
      if (isNaN(price) || price < 0) return ctx.reply('❌ السعر غلط. ارسل رقم.')
      await adminFlowState.set(userId, {
        step: 'awaiting_new_item_description',
        categoryId: flow.categoryId,
        name: flow.name,
        price
      })
      return ctx.reply('📝 ارسل *وصف* قصير (أو "-" بدون وصف).', { parse_mode: 'Markdown' })
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
      return ctx.reply(`✅ انضافت الوجبة "${flow.name}".`)
    }

    // ─── SLOT FLOWS ───────────────────────────────────────────

    if (flow.step === 'awaiting_slot_rename') {
      const { error } = await supabase.from('pickup_slots').update({ label: text }).eq('id', flow.slotId)
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply('✅ تحدث اسم الفترة.')
    }

    if (flow.step === 'awaiting_slot_max') {
      const n = parseInt(text, 10)
      if (isNaN(n) || n < 1) return ctx.reply('❌ ارسل رقم صحيح أكبر من صفر.')
      const { error } = await supabase.from('pickup_slots').update({ max_orders: n }).eq('id', flow.slotId)
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply(`✅ صار الحد الأقصى ${n} طلب.`)
    }

    if (flow.step === 'awaiting_new_slot_label') {
      await adminFlowState.set(userId, { step: 'awaiting_new_slot_time', label: text })
      return ctx.reply('🕐 ارسل *الوقت* بصيغة HH:MM (24 ساعة، مثال "12:00").', {
        parse_mode: 'Markdown'
      })
    }

    if (flow.step === 'awaiting_new_slot_time') {
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
        return ctx.reply('❌ الوقت غلط. استخدم HH:MM (مثال 12:00).')
      }
      const slotTime = text.length === 5 ? `${text}:00` : text
      await adminFlowState.set(userId, {
        step: 'awaiting_new_slot_max',
        label: flow.label,
        slot_time: slotTime
      })
      return ctx.reply('🔢 آخر شي: ارسل *الحد الأقصى للطلبات* لهاي الفترة.', {
        parse_mode: 'Markdown'
      })
    }

    if (flow.step === 'awaiting_new_slot_max') {
      const n = parseInt(text, 10)
      if (isNaN(n) || n < 1) return ctx.reply('❌ ارسل رقم صحيح أكبر من صفر.')
      const { error } = await supabase.from('pickup_slots').insert({
        label: flow.label,
        slot_time: flow.slot_time,
        max_orders: n,
        is_active: true
      })
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply(`✅ انضافت الفترة "${flow.label}".`)
    }

    // ─── BROADCAST FLOW ───────────────────────────────────────

    if (flow.step === 'awaiting_broadcast_message') {
      await adminFlowState.set(userId, { step: 'awaiting_broadcast_confirm', message: text })
      return ctx.reply(`📢 *معاينة:*\n\n${text}\n\nنرسلها لكل المستخدمين؟`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ ارسل', 'broadcast_confirm')],
          [Markup.button.callback('❌ إلغاء', 'broadcast_cancel')]
        ])
      })
    }

    // ─── ANALYTICS CUSTOM DAYS ────────────────────────────────

    if (flow.step === 'awaiting_analytics_days') {
      const n = parseInt(text, 10)
      if (isNaN(n) || n < 1 || n > 365) return ctx.reply('❌ ارسل رقم بين 1 و 365.')
      await adminFlowState.delete(userId)
      return showAnalytics(ctx, n)
    }

    // ─── TOPPING FLOWS ────────────────────────────────────────

    if (flow.step === 'awaiting_topping_name') {
      await adminFlowState.set(userId, { step: 'awaiting_topping_price', name: text })
      return ctx.reply('💲 ارسل *سعر* الإضافة (0 اذا مجانية).', { parse_mode: 'Markdown' })
    }

    if (flow.step === 'awaiting_topping_price') {
      const price = parseFloat(text)
      if (isNaN(price) || price < 0) return ctx.reply('❌ السعر غلط. ارسل رقم.')
      await adminFlowState.set(userId, { step: 'awaiting_topping_tag', name: flow.name, price })
      return ctx.reply('🏷 ارسل *تاغ* اختياري (مثال "extra") أو "-" بدون.', {
        parse_mode: 'Markdown'
      })
    }

    if (flow.step === 'awaiting_topping_tag') {
      const tag = text === '-' ? null : text
      const { error } = await supabase
        .from('toppings')
        .insert({ name: flow.name, price: flow.price, tag, is_active: true })
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply(`✅ انضافت الإضافة "${flow.name}".`)
    }

    // ─── GROUP FLOWS ──────────────────────────────────────────

    if (flow.step === 'awaiting_group_name') {
      await adminFlowState.set(userId, { step: 'awaiting_group_type', name: text })
      return ctx.reply(
        '📋 اختار نوع الاختيار:\n\nsingle = واحد بس\nmultiple = أكثر من واحد',
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
      return ctx.reply(`✅ تحدث اسم الإضافة إلى "${text}".`)
    }

    if (flow.step === 'awaiting_topping_new_price') {
      const price = parseFloat(text)
      if (isNaN(price) || price < 0) return ctx.reply('❌ السعر غلط. ارسل رقم.')
      const { error } = await supabase.from('toppings').update({ price }).eq('id', flow.toppingId)
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply(`✅ تحدث السعر إلى ${price}.`)
    }

    if (flow.step === 'awaiting_topping_new_tag') {
      const tag = text === '-' ? null : text
      const { error } = await supabase.from('toppings').update({ tag }).eq('id', flow.toppingId)
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply(tag ? `✅ صار التاغ "${tag}".` : '✅ انشال التاغ.')
    }

    // ─── EDIT GROUP FLOWS ─────────────────────────────────────

    if (flow.step === 'awaiting_group_new_name') {
      const { error } = await supabase.from('topping_groups').update({ name: text }).eq('id', flow.groupId)
      await adminFlowState.delete(userId)
      if (error) return ctx.reply(`❌ ${error.message}`)
      return ctx.reply(`✅ تحدث اسم المجموعة إلى "${text}".`)
    }
  })

  return bot
}

function helpText() {
  return (
    '❓ *مساعدة — Corner Bot*\n\n' +
    '🍽 *تصفح المنيو* — شوف الوجبات وأسعارها وخصص وجبتك\n' +
    '🛒 *سلتي* — عدل الكميات واختار وقت الاستلام وطريقة الدفع\n' +
    '📦 *طلباتي* — تابع حالة طلبك أو الغيه\n' +
    '🕐 *وقت الاستلام* — تختاره وقت تأكيد الطلب\n\n' +
    'بالدفع النقدي يتأكد الطلب مباشرة. بالدفع الإلكتروني انتظر رسالة تأكيد الدفع من البوت.\n' +
    'اذا مكتوب تجربة، الدفع اختبار وما ينرسل الطلب للمطبخ.\n' +
    'بعد تأكيد الطلب راح يطلعلك *رمز* (مثل ORD-7KQ2M). وريه عند الكاونتر.\n' +
    'وراح يوصلك إشعار لما يجهز طلبك 🌽\n\n' +
    'عندك سؤال؟ زورنا بـ Corner بالحرم الجامعي.'
  )
}

// Vercel/serverless entry points reuse one instance per warm container.
export const bot = createBot()

export default bot
