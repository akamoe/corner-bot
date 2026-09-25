/**
 * Telegram notifications for customers.
 *
 * `notifyStudent` has no caller inside this bot right now. The website changes
 * order status directly, so the kitchen cannot push to the customer from here.
 * Keep this function: the website notification path can use it later.
 */

import supabase from './supabase.js'
import { statusLabel } from './handlers/helpers.js'

/** Tell the customer their order moved to preparing / ready / cancelled. */
export async function notifyStudent(bot, order, status) {
  try {
    const headline = {
      preparing: '👨‍🍳 بدينا نحضر طلبك!',
      ready: `🔔 طلبك *${order.order_code}* جاهز — تعال خذه من الكاونتر!`,
      cancelled: `❌ طلبك *${order.order_code}* انلغى.`
    }[status]

    if (!headline) return

    const { data: userData, error } = await supabase
      .from('users')
      .select('telegram_id')
      .eq('id', order.user_id)
      .maybeSingle()

    if (error) {
      console.error('[notifyStudent] Error fetching user:', order.id, 'status:', status, error.message, error)
      return
    }
    if (!userData?.telegram_id) return

    const text =
      `${headline}\n\n` +
      `🎫 ${order.order_code}\n` +
      `📋 ${statusLabel(order.status || status)}\n` +
      `🕐 ${order.pickup_slots?.label || '—'}`

    await bot.telegram
      .sendMessage(userData.telegram_id, text, { parse_mode: 'Markdown' })
      .catch((err) => console.error(`[notifyStudent] Failed to notify ${userData.telegram_id}:`, err.message, err))
  } catch (err) {
    console.error('[notifyStudent] Unexpected error for order:', order?.id, 'status:', status, err.message, err)
  }
}
