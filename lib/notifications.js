/**
 * Telegram notifications for cashiers and students.
 */

import supabase from './supabase.js'
import { orderStatusButtons, cashierOrderCard, statusLabel, stripMarkdown } from './handlers/helpers.js'
import { formatIQD } from './money.js'

/** Queue recipients before confirming the cash basket, so a crash cannot lose them. */
export async function queueCashierNotices(userId, cartId) {
  const { data, error } = await supabase.rpc('queue_telegram_cash_staff_notices', {
    p_user_id: userId, p_cart_id: cartId
  })
  if (error || !data) throw new Error(`CASH_NOTICE_QUEUE_FAILED:${error?.code || 'empty'}`)
  return data
}

async function sendCashierMessage(bot, telegramId, message, buttons) {
  const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  try { await bot.telegram.sendMessage(telegramId, message, options) }
  catch (error) {
    if (!String(error.message || '').includes('parse entities')) throw error
    await bot.telegram.sendMessage(telegramId, stripMarkdown(message), {
      reply_markup: options.reply_markup
    })
  }
}

/** Send queued staff messages once per recipient. Failed sends stay pending. */
export async function notifyCashiers(bot, order) {
  const result = { sent: 0, failed: 0, pending: 0 }
  const { data: notices, error: readError } = await supabase
    .from('telegram_cash_staff_notices').select('*')
    .eq('order_id', order.id).eq('status', 'pending')
  if (readError) throw new Error('CASH_NOTICE_READ_FAILED')
  if (!notices?.length) return result

  let details = order
  if (!order?.order_items || !order?.pickup_slots) {
    const { data, error } = await supabase.from('orders')
      .select('*, order_items(*), pickup_slots(*)').eq('id', order.id).single()
    if (error) throw new Error('CASH_NOTICE_ORDER_READ_FAILED')
    details = data
  }
  if (!['confirmed', 'preparing', 'ready'].includes(details.status)) return result
  const message = `🔔 *طلب جديد!*\n\n${cashierOrderCard(details)}`
  const buttons = orderStatusButtons(details)
  const stale = new Date(Date.now() - 5 * 60_000).toISOString()

  for (const notice of notices) {
    if (notice.claimed_at) {
      if (Date.parse(notice.claimed_at) > Date.parse(stale)) { result.pending++; continue }
      const { error } = await supabase.from('telegram_cash_staff_notices')
        .update({ claimed_at: null }).eq('order_id', order.id)
        .eq('staff_id', notice.staff_id).eq('claimed_at', notice.claimed_at)
      if (error) { result.failed++; continue }
    }
    const { data: claim, error: claimError } = await supabase
      .from('telegram_cash_staff_notices')
      .update({ claimed_at: new Date().toISOString() })
      .eq('order_id', order.id).eq('staff_id', notice.staff_id)
      .eq('status', 'pending').is('claimed_at', null)
      .select('staff_id').maybeSingle()
    if (claimError) { result.failed++; continue }
    if (!claim) { result.pending++; continue }

    try {
      const { data: member, error } = await supabase.from('staff')
        .select('telegram_id, is_active, role').eq('id', notice.staff_id).maybeSingle()
      if (error) throw error
      if (!member?.telegram_id || !member.is_active || !['cashier', 'admin'].includes(member.role)) {
        await supabase.from('telegram_cash_staff_notices')
          .update({ status: 'skipped', claimed_at: null })
          .eq('order_id', order.id).eq('staff_id', notice.staff_id)
        result.failed++
        continue
      }
      await sendCashierMessage(bot, member.telegram_id, message, buttons)
      const { error: saved } = await supabase.from('telegram_cash_staff_notices')
        .update({ status: 'sent', sent_at: new Date().toISOString(), claimed_at: null })
        .eq('order_id', order.id).eq('staff_id', notice.staff_id)
      if (saved) throw saved
      result.sent++
    } catch (error) {
      result.failed++
      console.error('[notifyCashiers] Delivery failed:', error?.message || 'unknown')
      await supabase.from('telegram_cash_staff_notices')
        .update({ claimed_at: null }).eq('order_id', order.id).eq('staff_id', notice.staff_id)
    }
  }
  return result
}

/** Retry only orders that were queued through the bot cash flow. */
export async function retryCashierNotices(limit = 20, botOverride = null) {
  const { data: rows, error } = await supabase.from('telegram_cash_staff_notices')
    .select('order_id').eq('status', 'pending').order('created_at').limit(limit)
  if (error) throw new Error('CASH_NOTICE_RETRY_READ_FAILED')
  if (!rows?.length) return 0
  const bot = botOverride || (await import('./bot.js')).bot
  let sent = 0
  for (const orderId of new Set(rows.map((row) => row.order_id))) {
    try {
      const { data: order, error: orderError } = await supabase.from('orders')
        .select('*, order_items(*), pickup_slots(*)').eq('id', orderId).maybeSingle()
      if (orderError) throw orderError
      if (!order || ['cancelled', 'picked_up'].includes(order.status)) {
        await supabase.from('telegram_cash_staff_notices')
          .update({ status: 'skipped' }).eq('order_id', orderId).eq('status', 'pending')
        continue
      }
      if (order.status === 'pending') continue
      sent += (await notifyCashiers(bot, order)).sent
    } catch (err) { console.error('[retryCashierNotices] Retry failed:', err?.message || 'unknown') }
  }
  return sent
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
