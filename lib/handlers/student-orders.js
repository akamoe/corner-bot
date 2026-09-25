/**
 * 📦 طلباتي — a student's own order history, with self-service cancellation
 * while the order is still only `confirmed`.
 */

import { Markup } from 'telegraf'
import { getOrCreateUser } from '../auth.js'
import { getOrdersForUser, getActiveOrdersForUser, cancelOrderByStudent, getOrderById } from '../orders.js'
import { notifyStaffOrderCancelled } from '../notifications.js'
import { statusEmoji, statusLabel, formatIQD, safeRespond } from './helpers.js'

const LIVE = ['confirmed', 'preparing', 'ready']

function orderLine(order) {
  const items = (order.order_items || [])
    .map((i) => `${i.item_name} ×${i.quantity}`)
    .join('، ')
  return (
    `${statusEmoji(order.status)} *${order.order_code}* — ${statusLabel(order.status)}\n` +
    `🕐 ${order.pickup_slots?.label || '—'} · 💰 ${formatIQD(order.total_amount)}\n` +
    (items ? `🍽 ${items}` : '')
  ).trim()
}

export async function showMyOrders(ctx, userId) {
  const [recent, active] = await Promise.all([
    getOrdersForUser(userId, 5), getActiveOrdersForUser(userId)
  ])
  const orders = [...new Map([...active, ...recent].map((order) => [order.id, order])).values()]

  if (!orders.length) {
    return safeRespond(
      ctx,
      '📦 ما عندك طلبات بعد.\n\nتصفح المنيو واطلب أول وجبة 🌽',
      { ...Markup.inlineKeyboard([[Markup.button.callback('🍽 تصفح المنيو', 'catroot')]]) }
    )
  }

  const live = orders.filter((o) => LIVE.includes(o.status))
  const past = orders.filter((o) => !LIVE.includes(o.status))

  const blocks = []
  if (live.length) blocks.push('*طلباتك الحالية*\n\n' + live.map(orderLine).join('\n\n'))
  if (past.length) blocks.push('*طلباتك السابقة*\n\n' + past.slice(0, 3).map(orderLine).join('\n\n'))

  const rows = []
  for (const order of live) {
    if (order.status === 'confirmed') {
      rows.push([Markup.button.callback(`❌ إلغاء ${order.order_code}`, `cancelorder_${order.id}`)])
    }
  }
  rows.push([
    Markup.button.callback('🔄 تحديث', 'my_orders'),
    Markup.button.callback('🍽 تصفح المنيو', 'catroot')
  ])

  await safeRespond(ctx, `📦 *طلباتك*\n\n${blocks.join('\n\n')}`, {
    ...Markup.inlineKeyboard(rows)
  })
}

export async function confirmCancel(ctx, orderId) {
  const order = await getOrderById(orderId)
  if (!order) return safeRespond(ctx, '😕 ما لقينا الطلب.')

  return safeRespond(
    ctx,
    `❓ متأكد تريد تلغي الطلب *${order.order_code}*؟\n\n` +
      'اذا بدأ التحضير ما نقدر نلغيه.',
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ نعم، الغِ الطلب', `cancelorder_yes_${orderId}`)],
        [Markup.button.callback('↩️ رجوع', 'my_orders')]
      ])
    }
  )
}

export function setupStudentOrders(bot) {
  bot.hears(['📦 طلباتي', '📦 My Orders'], async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    await showMyOrders(ctx, user.id)
  })

  bot.action('my_orders', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const user = await getOrCreateUser(ctx.from.id)
    await showMyOrders(ctx, user.id)
  })

  bot.action(/^cancelorder_([0-9a-f-]{36})$/, async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const order = await getOrderById(ctx.match[1])

    if (!order || order.user_id !== user.id) {
      return ctx.answerCbQuery('ما لقينا الطلب.').catch(() => {})
    }

    await ctx.answerCbQuery().catch(() => {})
    await confirmCancel(ctx, order.id)
  })

  bot.action(/^cancelorder_yes_([0-9a-f-]{36})$/, async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const result = await cancelOrderByStudent(ctx.match[1], user.id)

    if (!result.ok) {
      const message = {
        locked: '👨‍🍳 بدأ التحضير — ما نقدر نلغي هسة.\nكلمنا بالكاونتر اذا عندك مشكلة.',
        forbidden: 'ما نقدر نلغي طلب مو طلبك.',
        missing: 'ما لقينا الطلب.',
        error: '⚠️ ما قدرنا نلغي الطلب. جرب ثاني.'
      }[result.reason] || '⚠️ ما قدرنا نلغي الطلب.'

      await ctx.answerCbQuery(message.split('\n')[0], { show_alert: true }).catch(() => {})
      await showMyOrders(ctx, user.id)
      return
    }

    await ctx.answerCbQuery('انلغى الطلب').catch(() => {})
    const full = await getOrderById(result.order.id)
    await notifyStaffOrderCancelled(bot, full || result.order)
    await showMyOrders(ctx, user.id)
  })
}
