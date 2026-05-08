import { Markup } from 'telegraf'
import supabase from './supabase.js'

export async function notifyCashiers(bot, order) {
  try {
    const { data: cashiers, error } = await supabase
      .from('staff')
      .select('telegram_id')
      .eq('role', 'cashier')
      .eq('is_active', true)

    if (error) {
      console.error('[notifyCashiers] Error fetching cashiers:', error.message, error)
      return
    }

    if (!cashiers?.length) return

    // Fetch order details with items and slot info in a single query
    let orderDetails = order
    if (!order.order_items || !order.pickup_slots) {
      const { data, error: fetchError } = await supabase
        .from('orders')
        .select('*, order_items(*), pickup_slots(label)')
        .eq('id', order.id)
        .single()
      if (fetchError) console.error('[notifyCashiers] Error fetching order details:', order.id, fetchError.message, fetchError)
      if (data) orderDetails = data
    }

    const items = orderDetails?.order_items?.map(i => `• ${i.item_name} x${i.quantity}`).join('\n') || ''
    const message =
      `🔔 *طلب جديد!*\n\n` +
      `🎫 *${order.order_code}*\n` +
      `🕐 وقت الاستلام: ${orderDetails?.pickup_slots?.label || 'N/A'}\n` +
      `💰 ${order.total_amount?.toFixed(2)} IQD\n\n` +
      `${items}`

    const buttons = [[Markup.button.callback('👨‍🍳 قيد التحضير', `status_${order.id}_preparing`)]]

    for (const cashier of cashiers) {
      if (cashier.telegram_id) {
        await bot.telegram.sendMessage(cashier.telegram_id, message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons)
        }).catch(err => console.error(`[notifyCashiers] Failed to notify cashier ${cashier.telegram_id}:`, err.message, err))
      }
    }
  } catch (err) {
    console.error('[notifyCashiers] Unexpected error for order:', order?.id, err.message, err)
  }
}

export async function notifyStudent(bot, order, status) {
  try {
    const messages = {
      preparing: '👨‍🍳 طلبك صار يتحضر!',
      ready: `🔔 طلبك *${order.order_code}* جاهز للاستلام! تعال هسة. 🌽`,
      cancelled: `❌ طلبك *${order.order_code}* تم إلغاؤه. تواصل ويانا.`
    }

    const msg = messages[status]
    if (!msg) return

    const { data: userData, error } = await supabase
      .from('users')
      .select('telegram_id')
      .eq('id', order.user_id)
      .maybeSingle()

    if (error) {
      console.error('[notifyStudent] Error fetching user for notification, order:', order.id, 'status:', status, error.message, error)
      return
    }

    if (userData?.telegram_id) {
      await bot.telegram.sendMessage(userData.telegram_id, msg, { parse_mode: 'Markdown' })
        .catch(err => console.error(`[notifyStudent] Failed to notify student ${userData.telegram_id}:`, err.message, err))
    }
  } catch (err) {
    console.error('[notifyStudent] Unexpected error for order:', order?.id, 'status:', status, err.message, err)
  }
}
