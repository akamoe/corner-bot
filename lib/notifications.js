/**
 * Telegram notifications for cashiers and students.
 */

import supabase from './supabase.js'
import { orderStatusButtons, cashierOrderCard, statusLabel } from './handlers/helpers.js'
import { formatIQD } from './money.js'

/** Tell every active cashier + admin that a new order landed. */
export async function notifyCashiers(bot, order) {
  try {
    const { data: staff, error } = await supabase
      .from('staff')
      .select('telegram_id, role')
      .eq('is_active', true)
      .in('role', ['cashier', 'admin'])

    if (error) {
      console.error('[notifyCashiers] Error fetching staff:', error.message, error)
      return
    }
    if (!staff?.length) return

    // Use the in-memory order when it already carries items + slot.
    let details = order
    if (!order?.order_items || !order?.pickup_slots) {
      const { data, error: fetchError } = await supabase
        .from('orders')
        .select('*, order_items(*), pickup_slots(*)')
        .eq('id', order.id)
        .single()

      if (fetchError) {
        console.error('[notifyCashiers] Error fetching order details:', order.id, fetchError.message, fetchError)
      }
      if (data) details = data
    }

    const text = `🔔 *طلب جديد!*\n\n${cashierOrderCard(details)}`
    const buttons = orderStatusButtons(details)

    for (const member of staff) {
      if (!member.telegram_id) continue
      await bot.telegram
        .sendMessage(member.telegram_id, text, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        })
        .catch((err) =>
          console.error(`[notifyCashiers] Failed to notify ${member.telegram_id}:`, err.message, err)
        )
    }
  } catch (err) {
    console.error('[notifyCashiers] Unexpected error for order:', order?.id, err.message, err)
  }
}

/** Tell staff a student cancelled their own order. */
export async function notifyStaffOrderCancelled(bot, order) {
  try {
    const { data: staff, error } = await supabase
      .from('staff')
      .select('telegram_id')
      .eq('is_active', true)
      .in('role', ['cashier', 'admin'])

    if (error) {
      console.error('[notifyStaffOrderCancelled] Error fetching staff:', error.message, error)
      return
    }
    if (!staff?.length) return

    const text =
      `❌ *الطلب ${order.order_code} انلغى من الطالب*\n` +
      `🕐 ${order.pickup_slots?.label || '—'} · 💰 ${formatIQD(order.total_amount)}`

    for (const member of staff) {
      if (!member.telegram_id) continue
      await bot.telegram
        .sendMessage(member.telegram_id, text, { parse_mode: 'Markdown' })
        .catch((err) =>
          console.error('[notifyStaffOrderCancelled] Failed to notify', member.telegram_id, err.message)
        )
    }
  } catch (err) {
    console.error('[notifyStaffOrderCancelled] Unexpected error:', order?.id, err.message, err)
  }
}

/** Tell the student their order moved to preparing / ready / cancelled. */
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
