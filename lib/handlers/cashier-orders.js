import { Markup } from 'telegraf'
import { getStaffRole } from '../auth.js'
import { getPendingOrders, updateOrderStatus, getOrderByCode } from '../orders.js'
import { notifyStudent } from '../notifications.js'

export function setupCashierOrders(bot) {
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
}
