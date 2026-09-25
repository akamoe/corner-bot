/**
 * Student cart + checkout.
 *
 * The old cart appended "✅ تم التحديث" to the same message on every tap, so
 * quantities, totals and the confirmation card all drifted out of sync. Here
 * the cart is a set of tracked messages that get edited in place:
 *
 *   [summary: total + تأكيد/ملاحظة/تفريغ]
 *   [item 1: ➖ ➕ 🗑]
 *   [item 2: ➖ ➕ 🗑]
 *
 * Booking a slot re-checks capacity server-side, so two students racing for
 * the last spot can't oversell it.
 */

import { Markup } from 'telegraf'
import { getOrCreateUser } from '../auth.js'
import { getCart, updateCartItemQuantity, removeItemFromCart, clearCart } from '../cart.js'
import { getAvailableSlots, getSlotBookability } from '../slots.js'
import { confirmOrder, SlotFullError } from '../orders.js'
import { notifyCashiers } from '../notifications.js'
import { cartUiState, orderFlowState } from '../state.js'
import { formatIQD } from '../money.js'
import { createWaylCheckout, paymentForCart, latestPaymentForUser, waylConfig, reconcileWaylPayment } from '../wayl.js'
import { safeCheckoutUrl } from '../wayl-core.js'
import supabase from '../supabase.js'
import {
  formatItemToppings,
  studentOrderCard,
  safeReply,
  safeEdit
} from './helpers.js'

const SLOT_REASONS = {
  missing: '😕 ما لقينا هاي الفترة.',
  inactive: '😕 هاي الفترة ما متاحة هسة.',
  past: '⌛ فات وقت هاي الفترة. اختار وقت ثاني.',
  full: '😕 امتلات هاي الفترة. اختار وقت ثاني.'
}

function itemText(item) {
  const toppings = formatItemToppings(item.customization)
  return (
    `🍽 *${item.item_name}*\n` +
    (toppings ? `🧀 ${toppings}\n` : '') +
    `💰 ${formatIQD(item.item_price)} × ${item.quantity} = *${formatIQD(
      Number(item.item_price) * Number(item.quantity)
    )}*`
  )
}

function cartTotals(cart) {
  const items = cart?.order_items || []
  const total = items.reduce((sum, i) => sum + Number(i.item_price) * Number(i.quantity), 0)
  const count = items.reduce((sum, i) => sum + Number(i.quantity), 0)
  return { items, total, count }
}

function summaryText(totals, notes) {
  return (
    `🛒 *سلتك* (${totals.count} غرض)\n` +
    `💰 المجموع: *${formatIQD(totals.total)}*` +
    (notes ? `\n📝 ملاحظة: ${notes}` : '')
  )
}

function summaryKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ تأكيد الطلب', 'confirm_order')],
    [
      Markup.button.callback('📝 ملاحظة', 'cart_note'),
      Markup.button.callback('🗑 تفريغ السلة', 'clear_cart')
    ]
  ])
}

function emptyCartKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('🍽 تصفح المنيو', 'catroot')]])
}

async function forgetMessages(ctx, telegramId) {
  const tracked = await cartUiState.get(telegramId)
  if (!tracked) return

  const ids = [tracked.summaryId, tracked.slotsId, ...Object.values(tracked.items || {})].filter(Boolean)
  await Promise.allSettled(ids.map((id) => ctx.telegram.deleteMessage(ctx.chat.id, id).catch(() => {})))
  await cartUiState.delete(telegramId)
}

/**
 * Draw (or redraw) the cart screen.
 * `userId` is the bot user row id, `telegramId` the Telegram chat user id.
 */
export async function showCart(ctx, userId, telegramId) {
  const cart = await getCart(userId)
  const totals = cartTotals(cart)
  const payment = totals.items.length ? await paymentForCart(cart.id) : null
  await forgetMessages(ctx, telegramId)

  if (!totals.items.length) {
    await cartUiState.delete(telegramId)
    return safeReply(
      ctx,
      '🛒 سلتك فاضية.\n\nتصفح المنيو وضيف اللي تحبه 🌽',
      { ...emptyCartKeyboard() }
    )
  }

  if (payment) {
    const buttons = []
    if (waylConfig() && payment.checkout_url) {
      try { buttons.push([Markup.button.url('🔗 افتح رابط الدفع', safeCheckoutUrl(payment.checkout_url))]) }
      catch { /* An invalid stored URL is never sent. */ }
    }
    buttons.push([Markup.button.callback('🔄 تحقق من الدفع', 'wayl_status')])
    return safeReply(ctx,
      `⏳ عندك دفع قيد الانتظار.\n💰 المبلغ: ${formatIQD(payment.amount)}` +
      `\n🕐 الاستلام: ${payment.pickup_slots?.label || 'الوقت المختار'}` +
      '\nطلبك ما وصل للمطبخ بعد.',
      { ...Markup.inlineKeyboard(buttons) })
  }

  const summary = await safeReply(ctx, summaryText(totals, cart.notes), {
    ...summaryKeyboard()
  })

  const itemIds = {}
  for (const item of totals.items) {
    const msg = await safeReply(ctx, itemText(item), {
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('➖', `cart_qty_down_${item.id}`),
          Markup.button.callback('➕', `cart_qty_up_${item.id}`),
          Markup.button.callback('🗑 حذف', `cart_rm_${item.id}`)
        ]
      ])
    })
    itemIds[item.id] = msg.message_id
  }

  await cartUiState.set(telegramId, {
    summaryId: summary?.message_id || null,
    items: itemIds
  })
}

/** Re-render the summary line (and hide it when the cart empties). */
async function refreshSummary(ctx, userId, telegramId) {
  const tracked = await cartUiState.get(telegramId)
  const cart = await getCart(userId)
  const totals = cartTotals(cart)

  if (!tracked?.summaryId) return

  const chatId = ctx.chat.id
  const edit = (text, extra) =>
    ctx.telegram.editMessageText(chatId, tracked.summaryId, undefined, text, {
      parse_mode: 'Markdown',
      ...extra
    })

  try {
    if (!totals.items.length) {
      await edit('🛒 سلتك فاضية.\n\nتصفح المنيو وضيف اللي تحبه 🌽', {
        reply_markup: { inline_keyboard: emptyCartKeyboard().reply_markup.inline_keyboard }
      })
      await Promise.allSettled(
        Object.values(tracked.items || {}).map((id) =>
          ctx.telegram.deleteMessage(chatId, id).catch(() => {})
        )
      )
      await cartUiState.delete(telegramId)
      return
    }

    await edit(summaryText(totals, cart.notes), {
      reply_markup: { inline_keyboard: summaryKeyboard().reply_markup.inline_keyboard }
    })
  } catch (err) {
    if (String(err.message || '').includes('not modified')) return
    console.error('[studentCart] refreshSummary failed userId:', userId, err.message, err)
    await safeReply(ctx, '⚠️ ما قدرنا نحدث عرض السلة. اضغط عرض السلة حتى تشوف آخر تغيير.',
      { ...Markup.inlineKeyboard([[Markup.button.callback('🔄 عرض السلة', 'view_cart')]]) })
  }
}

async function updateItemMessage(ctx, userId, telegramId, itemId) {
  const tracked = await cartUiState.get(telegramId)
  const messageId = tracked?.items?.[itemId]
  if (!messageId) return

  const cart = await getCart(userId)
  const item = (cart?.order_items || []).find((i) => i.id === itemId)

  if (!item) {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {})
    delete tracked.items[itemId]
    await cartUiState.set(telegramId, tracked)
    return
  }

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, itemText(item), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➖', callback_data: `cart_qty_down_${item.id}` },
            { text: '➕', callback_data: `cart_qty_up_${item.id}` },
            { text: '🗑 حذف', callback_data: `cart_rm_${item.id}` }
          ]
        ]
      }
    })
  } catch (err) {
    if (!String(err.message || '').includes('not modified')) {
      console.error('[studentCart] updateItemMessage failed itemId:', itemId, err.message, err)
      await safeReply(ctx, '⚠️ ما قدرنا نحدث الغرض هنا. افتح السلة حتى تشوف الكمية الصحيحة.',
        { ...Markup.inlineKeyboard([[Markup.button.callback('🔄 عرض السلة', 'view_cart')]]) })
    }
  }
}

async function offerSlots(ctx, userId, telegramId) {
  const slots = await getAvailableSlots()

  if (!slots.length) {
    return safeReply(
      ctx,
      '⌛ ما بقى أوقات استلام متاحة اليوم.\nجرّب بعدين أو كلمنا بالكاونتر.',
      { ...Markup.inlineKeyboard([[Markup.button.callback('🛒 رجوع للسلة', 'view_cart')]]) }
    )
  }

  const rows = slots.map((slot) => [
    Markup.button.callback(
      `🕐 ${slot.label}${slot.spots_left === null ? '' : ` — باقي ${slot.spots_left}`}`,
      `slot_${slot.id}`
    )
  ])
  rows.push([Markup.button.callback('❌ إلغاء', 'cancel_slots')])

  const msg = await safeReply(ctx, '📅 *اختار وقت الاستلام:*', { ...Markup.inlineKeyboard(rows) })

  const tracked = (await cartUiState.get(telegramId)) || {}
  await cartUiState.set(telegramId, { ...tracked, slotsId: msg?.message_id || null })
}

export function setupStudentCart(bot) {
  // ─── CART SCREEN ─────────────────────────────────────────────

  bot.hears(['🛒 سلتي', '🛒 My Cart'], async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    await showCart(ctx, user.id, ctx.from.id)
  })

  bot.action('view_cart', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await orderFlowState.delete(ctx.from.id)
    const user = await getOrCreateUser(ctx.from.id)
    await showCart(ctx, user.id, ctx.from.id)
  })

  // ─── ITEM QUANTITY / REMOVE ──────────────────────────────────

  bot.action(/^cart_qty_up_(.+)$/, async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const itemId = ctx.match[1]
    try {
      await updateCartItemQuantity(user.id, itemId, 1)
    } catch (err) {
      console.error('[studentCart] qty_up failed itemId:', itemId, err.message)
      return ctx.answerCbQuery('⚠️ ما قدرنا نغيّر الكمية. جرب ثاني.', { show_alert: true }).catch(() => {})
    }
    await ctx.answerCbQuery('➕').catch(() => {})
    await updateItemMessage(ctx, user.id, ctx.from.id, itemId)
    await refreshSummary(ctx, user.id, ctx.from.id)
  })

  bot.action(/^cart_qty_down_(.+)$/, async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const itemId = ctx.match[1]
    let qty
    try { qty = await updateCartItemQuantity(user.id, itemId, -1) }
    catch (err) {
      console.error('[studentCart] qty_down failed itemId:', itemId, err.message)
      return ctx.answerCbQuery('⚠️ ما قدرنا نغيّر الكمية. جرب ثاني.', { show_alert: true }).catch(() => {})
    }
    await ctx.answerCbQuery(qty === null ? 'انشال من السلة' : '➖').catch(() => {})
    await updateItemMessage(ctx, user.id, ctx.from.id, itemId)
    await refreshSummary(ctx, user.id, ctx.from.id)
  })

  bot.action(/^cart_rm_(.+)$/, async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const itemId = ctx.match[1]
    try {
      await removeItemFromCart(user.id, itemId)
      await ctx.answerCbQuery('انشال من السلة').catch(() => {})
    } catch (err) {
      console.error('[studentCart] cart_rm failed itemId:', itemId, err.message, err)
      await ctx.answerCbQuery('⚠️ ما قدرنا نحذفه. جرب ثاني.').catch(() => {})
      return
    }

    await ctx.deleteMessage().catch(() => {})
    const tracked = await cartUiState.get(ctx.from.id)
    if (tracked?.items?.[itemId]) {
      delete tracked.items[itemId]
      await cartUiState.set(ctx.from.id, tracked)
    }
    await refreshSummary(ctx, user.id, ctx.from.id)
  })

  bot.action('clear_cart', async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    try {
      await clearCart(user.id)
      await ctx.answerCbQuery('تفاضت السلة').catch(() => {})
    } catch (err) {
      console.error('[studentCart] clear_cart failed userId:', user.id, err.message, err)
      await ctx.answerCbQuery('⚠️ ما قدرنا نفضيها. جرب ثاني.').catch(() => {})
      return
    }
    await refreshSummary(ctx, user.id, ctx.from.id)
  })

  // ─── ORDER NOTE ──────────────────────────────────────────────

  bot.action('cart_note', async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const cart = await getCart(user.id)
    if (!cartTotals(cart).items.length) {
      return ctx.answerCbQuery('سلتك فاضية.').catch(() => {})
    }

    await ctx.answerCbQuery().catch(() => {})
    await orderFlowState.set(ctx.from.id, { step: 'awaiting_cart_note' })
    await safeReply(
      ctx,
      '📝 اكتب ملاحظتك (مثلاً: بدون بصل، حار زيادة) وابعثها.\nاذا ما تريد ملاحظة اضغط إلغاء.',
      { ...Markup.inlineKeyboard([[Markup.button.callback('↩️ إلغاء ورجوع للسلة', 'view_cart')]]) }
    )
  })

  // Consumes the note text before the global text handler sees it.
  bot.on('text', async (ctx, next) => {
    const state = await orderFlowState.get(ctx.from.id)
    if (state?.step !== 'awaiting_cart_note') return next()

    const note = ctx.message.text.trim().slice(0, 200)
    const user = await getOrCreateUser(ctx.from.id)
    const cart = await getCart(user.id)

    await orderFlowState.delete(ctx.from.id)

    if (!cart) {
      return safeReply(ctx, '🛒 سلتك فاضية.', { ...emptyCartKeyboard() })
    }

    const { error } = await supabase.from('orders').update({ notes: note }).eq('id', cart.id)
    if (error) {
      console.error('[studentCart] saving note failed cartId:', cart.id, error.message, error)
      await ctx.reply('⚠️ ما قدرنا نحفظ الملاحظة.')
    } else {
      await ctx.reply(`✅ سجلنا ملاحظتك: ${note}`)
    }

    await showCart(ctx, user.id, ctx.from.id)
  })

  // ─── CHECKOUT: SLOT ──────────────────────────────────────────

  bot.action('confirm_order', async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const cart = await getCart(user.id)

    if (!cartTotals(cart).items.length) {
      return ctx.answerCbQuery('سلتك فاضية — ضيف غرض أول.', { show_alert: true }).catch(() => {})
    }

    if (await paymentForCart(cart.id)) {
      await ctx.answerCbQuery('عندك دفع قيد الانتظار.', { show_alert: true }).catch(() => {})
      return showCart(ctx, user.id, ctx.from.id)
    }

    await ctx.answerCbQuery().catch(() => {})
    await offerSlots(ctx, user.id, ctx.from.id)
  })

  bot.action('cancel_slots', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await safeEdit(ctx, '❌ لغينا اختيار الوقت.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🛒 رجوع للسلة', 'view_cart')]])
    })
  })

  bot.action(/^slot_([0-9a-f-]{36})$/, async (ctx) => {
    const slotId = ctx.match[1]
    const telegramId = ctx.from.id
    const user = await getOrCreateUser(telegramId)
    const cart = await getCart(user.id)

    if (!cartTotals(cart).items.length) {
      return ctx.answerCbQuery('سلتك فاضية.', { show_alert: true }).catch(() => {})
    }

    if (await paymentForCart(cart.id)) {
      await ctx.answerCbQuery('عندك دفع قيد الانتظار.', { show_alert: true }).catch(() => {})
      return showCart(ctx, user.id, telegramId)
    }

    const bookable = await getSlotBookability(slotId)
    if (!bookable.ok) {
      await ctx.answerCbQuery(SLOT_REASONS[bookable.reason] || 'ما قدرنا نحجز هاي الفترة.', { show_alert: true }).catch(() => {})
      const tracked = await cartUiState.get(telegramId)
      if (tracked?.slotsId) await ctx.telegram.deleteMessage(ctx.chat.id, tracked.slotsId).catch(() => {})
      return offerSlots(ctx, user.id, telegramId)
    }

    await ctx.answerCbQuery().catch(() => {})
    const totals = cartTotals(cart)
    const rows = [[Markup.button.callback('💵 أدفع نقداً عند الاستلام', `pay_cash_${slotId}`)]]
    const config = waylConfig()
    if (config) rows.push([Markup.button.callback(
      config.environment === 'test' ? '🧪 جرّب الدفع الإلكتروني' : '💳 أدفع إلكترونياً',
      `pay_wayl_${slotId}`
    )])
    rows.push([Markup.button.callback('↩️ رجوع للأوقات', 'confirm_order')])
    const testNote = config?.environment === 'test'
      ? '\n\n🧪 الدفع الإلكتروني تجربة فقط. الدفع النقدي طلب حقيقي ينرسل للكاونتر.'
      : ''
    return safeReply(ctx,
      `📋 *راجع طلبك*\n${summaryText(totals, cart.notes)}\n🕐 الاستلام: ${bookable.slot.label}` +
      `${testNote}\n\nاختار طريقة الدفع:`,
      { ...Markup.inlineKeyboard(rows) })
  })

  bot.action(/^pay_cash_([0-9a-f-]{36})$/, async (ctx) => {
    const slotId = ctx.match[1]
    const telegramId = ctx.from.id
    const user = await getOrCreateUser(telegramId)
    const cart = await getCart(user.id)
    if (!cartTotals(cart).items.length) return ctx.answerCbQuery('سلتك فاضية.', { show_alert: true }).catch(() => {})
    if (await paymentForCart(cart.id)) return ctx.answerCbQuery('عندك دفع قيد الانتظار.', { show_alert: true }).catch(() => {})
    const bookable = await getSlotBookability(slotId)
    if (!bookable.ok) {
      await ctx.answerCbQuery(SLOT_REASONS[bookable.reason] || 'ما قدرنا نحجز هاي الفترة.', { show_alert: true }).catch(() => {})
      return offerSlots(ctx, user.id, telegramId)
    }
    await ctx.answerCbQuery('جاري تثبيت الطلب...').catch(() => {})

    let order
    try {
      order = await confirmOrder(cart.id, slotId)
    } catch (err) {
      if (err instanceof SlotFullError) {
        await ctx.reply('😕 سبقوك على هاي الفترة — اختار وقت ثاني:')
        return offerSlots(ctx, user.id, telegramId)
      }
      console.error('[studentCart] confirmOrder failed cartId:', cart.id, 'slotId:', slotId, err)
      await ctx.reply('⚠️ ما قدرنا نثبت الطلب. جرب مرة ثانية.')
      return
    }

    await forgetMessages(ctx, telegramId)

    const full = await supabase
      .from('orders')
      .select('*, order_items(*), pickup_slots(*)')
      .eq('id', order.id)
      .maybeSingle()

    const card = studentOrderCard(full.data || { ...order, pickup_slots: bookable.slot })

    await safeReply(
      ctx,
      `✅ *تم تثبيت طلبك!*\n\n${card}\n\n` +
        'وري الرمز عند الكاونتر وقت الاستلام.\nراح نرسلك إشعار لما يجهز 🌽',
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📦 طلباتي', 'my_orders')],
          [Markup.button.callback('🍽 أطلب غرض ثاني', 'catroot')]
        ])
      }
    )

    const notice = await notifyCashiers(bot, full.data || order)
    if (notice.failed || !notice.sent) {
      await safeReply(ctx,
        `⚠️ طلبك مثبت بالرمز ${order.order_code}، بس إشعار الكاونتر ما اكتمل. ورّيهم الرمز مباشرة وقت الاستلام.`)
    }
  })

  bot.action(/^pay_wayl_([0-9a-f-]{36})$/, async (ctx) => {
    const config = waylConfig()
    if (!config) return ctx.answerCbQuery('الدفع الإلكتروني مو متاح هسة.', { show_alert: true }).catch(() => {})
    const user = await getOrCreateUser(ctx.from.id)
    const cart = await getCart(user.id)
    if (!cartTotals(cart).items.length) return ctx.answerCbQuery('سلتك فاضية.', { show_alert: true }).catch(() => {})
    const bookable = await getSlotBookability(ctx.match[1])
    if (!bookable.ok) return ctx.answerCbQuery(
      SLOT_REASONS[bookable.reason] || 'ما قدرنا نحجز هاي الفترة.',
      { show_alert: true }
    ).catch(() => {})
    await ctx.answerCbQuery('جاري تجهيز رابط الدفع...').catch(() => {})
    try {
      const checkout = await createWaylCheckout(user.id, cart.id, ctx.match[1])
      if (checkout.status !== 'pending' || !checkout.url) {
        return safeReply(ctx, '⚠️ ما قدرنا نجهز رابط الدفع. تحقق من الحالة أو جرب مرة ثانية.',
          { ...Markup.inlineKeyboard([[Markup.button.callback('🔄 تحقق من الدفع', 'wayl_status')]]) })
      }
      await forgetMessages(ctx, ctx.from.id)
      const note = config.environment === 'test'
        ? '🧪 هذا دفع تجريبي فقط. ما راح ينرسل طلب للمطبخ.'
        : '⏳ الطلب ما ينرسل للمطبخ إلا بعد ما يوصلنا تأكيد الدفع.'
      return safeReply(ctx,
        `${note}\n💰 المبلغ: ${formatIQD(checkout.payment.amount)}` +
        `\n🕐 الاستلام: ${bookable.slot.label}` +
        '\n\nافتح الرابط وأكمل الدفع، وبعدها تحقق من الحالة هنا.',
        { ...Markup.inlineKeyboard([
          [Markup.button.url('🔗 افتح رابط Wayl', checkout.url)],
          [Markup.button.callback('🔄 تحقق من الدفع', 'wayl_status')]
        ]) })
    } catch (error) {
      console.error('[studentCart] Wayl checkout failed:', error?.message || 'unknown')
      return safeReply(ctx, '⚠️ ما قدرنا نجهز الدفع هسة. سلتك محفوظة، جرب مرة ثانية.',
        { ...Markup.inlineKeyboard([[Markup.button.callback('🛒 رجوع للسلة', 'view_cart')]]) })
    }
  })

  bot.action('wayl_status', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const user = await getOrCreateUser(ctx.from.id)
    const payment = await latestPaymentForUser(user.id)
    if (!payment) return safeReply(ctx, 'ما عندك عملية دفع هسة.')
    try {
      const result = await reconcileWaylPayment(payment.reference)
      if (result.status === 'paid') return safeReply(ctx,
        payment.environment === 'test'
          ? '🧪 تأكدنا من الدفع التجريبي. هذا اختبار فقط، وطلبك ما انرسل للمطبخ.'
          : '✅ تأكدنا من الدفع. تابع طلبك من زر طلباتي.')
      if (result.status === 'cancelled') return safeReply(ctx, '❌ ما اكتمل الدفع. سلتك بعده محفوظة.')
      if (result.status === 'refunded') return safeReply(ctx, '↩️ انرجع المبلغ. كلمنا بالكاونتر إذا تحتاج مساعدة.')
      return safeReply(ctx, '⏳ الدفع بعده قيد الانتظار. جرب التحقق بعد شوي.')
    } catch {
      return safeReply(ctx, '⚠️ ما قدرنا نتحقق من الدفع هسة. جرب بعد شوي.')
    }
  })
}
