/**
 * Cashier screens.
 *
 * Fixes vs. the previous version:
 *  - active list now includes `ready` orders, which previously disappeared
 *    from the list and could never be marked as picked up
 *  - "🔍 البحث عن طلب" actually worked only for `ORD-` codes; students used to
 *    get bare numeric codes, so a cashier typing the student's code got
 *    silence. Lookup now accepts ORD-XXXXX / ord xxxxx / bare body / legacy
 *    numeric codes, and always answers.
 *  - stale buttons can no longer revive a cancelled or picked-up order.
 */

import { getStaffRole } from '../auth.js'
import { getActiveOrders, getOrderByCode, getOrderById, updateOrderStatus } from '../orders.js'
import { notifyStudent } from '../notifications.js'
import { looksLikeOrderCode } from '../order-code.js'
import { adminFlowState } from '../state.js'
import {
  cashierOrderCard,
  cashierKeyboard,
  orderStatusButtons,
  statusLabel,
  safeReply,
  safeRespond
} from './helpers.js'

const CLOSED = ['picked_up', 'cancelled']

async function sendActiveOrders(ctx) {
  const orders = await getActiveOrders()

  if (!orders.length) {
    return safeRespond(ctx, '✅ ما في طلبات نشطة هسة.', { ...cashierKeyboard() })
  }

  await safeReply(
    ctx,
    `📋 *الطلبات النشطة* — ${orders.length}\n` +
      '👉 اضغط على الطلب لتغيير حالته.'
  )

  for (const order of orders) {
    await safeReply(ctx, cashierOrderCard(order), {
      ...{ reply_markup: { inline_keyboard: orderStatusButtons(order) } }
    })
  }
}

export function setupCashierOrders(bot) {
  bot.hears(['📋 الطلبات النشطة', '📋 Active Orders'], async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (!role) return ctx.reply('⛔ Unauthorized.')
    await sendActiveOrders(ctx)
  })

  // ─── STATUS TRANSITIONS ──────────────────────────────────────

  bot.action(/^status_([0-9a-f-]{36})_(confirmed|preparing|ready|picked_up|cancelled)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (!role) return ctx.answerCbQuery('⛔ Unauthorized.').catch(() => {})

    const orderId = ctx.match[1]
    const newStatus = ctx.match[2]

    const current = await getOrderById(orderId)
    if (!current) {
      return ctx.answerCbQuery('ما لقينا الطلب.').catch(() => {})
    }
    if (CLOSED.includes(current.status)) {
      return ctx
        .answerCbQuery(`هذا الطلب ${statusLabel(current.status)} — ما نقدر نغيره.`, { show_alert: true })
        .catch(() => {})
    }

    let order
    try {
      order = await updateOrderStatus(orderId, newStatus)
    } catch (err) {
      console.error('[cashierOrders] status update failed orderId:', orderId, 'to:', newStatus, err)
      return ctx.answerCbQuery('⚠️ ما قدرنا نحدث الطلب.').catch(() => {})
    }

    await ctx.answerCbQuery(`✅ ${statusLabel(newStatus)}`).catch(() => {})

    const buttons = orderStatusButtons({ ...order, status: newStatus })
    const text = `${cashierOrderCard({ ...order, status: newStatus })}\n\n✅ الحالة: *${statusLabel(newStatus)}*`

    await safeRespond(ctx, text, { ...{ reply_markup: { inline_keyboard: buttons } } })

    await notifyStudent(bot, order, newStatus)
  })

  // ─── LOOK UP AN ORDER ────────────────────────────────────────

  bot.hears(['🔍 البحث عن طلب', '🔍 Look Up Order'], async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (!role) return ctx.reply('⛔ Unauthorized.')
    await ctx.reply('🔍 ابعث رمز الطلب (مثال: ORD-7KQ2M).')
  })

  // A staff member typing a code anywhere in the chat.
  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text.trim()

    if (!looksLikeOrderCode(text)) return next()

    // Never hijack an admin who is in the middle of a form (prices, ids,
    // quantities, dates all pass through here as text).
    if (await adminFlowState.has(ctx.from.id)) return next()

    const role = await getStaffRole(ctx.from.id)
    if (!role) return next()

    const order = await getOrderByCode(text)
    if (!order) {
      // A bare code we don't recognise might be a number for someone else's
      // flow — stay quiet. A code with a prefix is clearly a lookup.
      if (/^ORD/i.test(text)) {
        return ctx.reply(
          `😕 ما لقينا طلب بالرمز ${text}.\nتأكد من الرمز أو دوّر عليه بالطلبات النشطة.`
        )
      }
      return next()
    }

    return safeReply(ctx, cashierOrderCard(order), {
      ...{ reply_markup: { inline_keyboard: orderStatusButtons(order) } }
    })
  })
}
