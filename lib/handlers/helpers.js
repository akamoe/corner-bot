/**
 * Shared presentation helpers.
 *
 * One place decides how an order, its toppings and its status are rendered so
 * the student card, the cashier card, the admin listing and the Telegram
 * notification never drift apart.
 */

import { Markup } from 'telegraf'
import { parseCustomization } from '../toppings.js'
import { formatIQD } from '../money.js'

// Re-exported so callers can pull presentation + formatting from one module.
export { formatIQD }

export const STATUS_LABELS = {
  pending: 'بالسلة',
  confirmed: 'مؤكد — بانتظار التحضير',
  preparing: 'قيد التحضير',
  ready: 'جاهز للاستلام',
  picked_up: 'تم الاستلام',
  cancelled: 'ملغي'
}

export const STATUS_EMOJI = {
  pending: '🛒',
  confirmed: '✅',
  preparing: '👨‍🍳',
  ready: '🔔',
  picked_up: '✔️',
  cancelled: '❌'
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || '—'
}

export function statusEmoji(status) {
  return STATUS_EMOJI[status] || '•'
}

/** "🧀 جبن شيدر، صوص حار (+500 د.ع)" — toppings of one order item. */
export function formatItemToppings(customization) {
  const custom = parseCustomization(customization)
  const toppings = (custom.toppings || []).filter(Boolean)
  if (!toppings.length) return ''
  return toppings
    .map((t) => (Number(t.price) > 0 ? `${t.name} (+${formatIQD(t.price)})` : t.name))
    .join('، ')
}

/** Multi-line item list used by every order card. */
export function formatOrderItems(orderItems) {
  const items = orderItems || []
  if (!items.length) return '(ماكو أغراض)'

  return items
    .map((i) => {
      const line = `• ${i.item_name} ×${i.quantity} — ${formatIQD(Number(i.item_price) * Number(i.quantity))}`
      const toppings = formatItemToppings(i.customization)
      return toppings ? `${line}\n   └ 🧀 ${toppings}` : line
    })
    .join('\n')
}

/** Kept for the `/cart` command in webhook.js. */
export function formatOrderSummary(items) {
  return formatOrderItems(items)
}

/** The card a student sees after ordering and in 📦 طلباتي. */
export function studentOrderCard(order) {
  const lines = [
    `${statusEmoji(order.status)} *الطلب ${order.order_code}*`,
    `📋 الحالة: ${statusLabel(order.status)}`,
    `🕐 وقت الاستلام: ${order.pickup_slots?.label || '—'}`,
    `💰 المجموع: ${formatIQD(order.total_amount)}`,
    ''
  ]
  const items = formatOrderItems(order.order_items)
  if (items) lines.push(items)
  if (order.notes) lines.push('', `📝 ملاحظة: ${order.notes}`)
  return lines.join('\n')
}

/** The card a cashier sees: adds the customer token. */
export function cashierOrderCard(order) {
  const lines = [
    `🎫 *${order.order_code}*`,
    `📋 الحالة: ${statusLabel(order.status)}`,
    `🕐 وقت الاستلام: ${order.pickup_slots?.label || '—'}`,
    `👤 العميل: ${order.users?.anonymous_token || '—'}`,
    `💰 ${formatIQD(order.total_amount)}`,
    ''
  ]
  const items = formatOrderItems(order.order_items)
  if (items) lines.push(items)
  if (order.notes) lines.push('', `📝 ملاحظة: ${order.notes}`)
  return lines.join('\n')
}

/** Action buttons a cashier gets for an order, based on its status. */
export function orderStatusButtons(order) {
  const rows = []
  if (order.status === 'confirmed') {
    rows.push([Markup.button.callback('👨‍🍳 ابدأ التحضير', `status_${order.id}_preparing`)])
    rows.push([Markup.button.callback('❌ إلغاء الطلب', `status_${order.id}_cancelled`)])
  } else if (order.status === 'preparing') {
    rows.push([Markup.button.callback('🔔 جاهز للاستلام', `status_${order.id}_ready`)])
    rows.push([Markup.button.callback('❌ إلغاء الطلب', `status_${order.id}_cancelled`)])
  } else if (order.status === 'ready') {
    rows.push([Markup.button.callback('✔️ تم استلام الطلب', `status_${order.id}_picked_up`)])
  }
  return rows
}

/** Reply with Markdown, falling back to plain text if Telegram rejects it. */
export async function safeReply(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', ...extra })
  } catch (err) {
    console.error('[safeReply] Markdown failed, retrying plain:', err.message)
    try { return await ctx.reply(stripMarkdown(text), extra) }
    catch (e) {
      console.error('[safeReply] plain reply failed:', e.message)
      throw e
    }
  }
}

/** Same as safeReply but edits the current message. */
export async function safeEdit(ctx, text, extra = {}) {
  try {
    return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra })
  } catch (err) {
    if (String(err.message || '').includes('not modified')) return ctx.callbackQuery?.message || true
    console.error('[safeEdit] Markdown failed, retrying plain:', err.message)
    try { return await ctx.editMessageText(stripMarkdown(text), extra) }
    catch (e) {
      console.error('[safeEdit] plain edit failed:', e.message)
      throw e
    }
  }
}

/**
 * Edit the message the button was pressed on when possible, otherwise send a
 * new one. Keeps navigation inside a single message for button flows while
 * still working for plain text commands.
 */
export async function safeRespond(ctx, text, extra = {}) {
  if (ctx.callbackQuery?.message) {
    const edited = await safeEdit(ctx, text, extra)
    if (edited !== null) return edited
  }
  return safeReply(ctx, text, extra)
}

export function stripMarkdown(text) {
  return String(text ?? '').replace(/[*_`\[\]]/g, '')
}

export function calculateFinalPrice(basePrice, selectedToppingIds, groups) {
  let extra = 0
  const allToppings = (groups || []).flatMap((g) => g.toppings || [])
  for (const tid of selectedToppingIds || []) {
    const t = allToppings.find((x) => x.id === tid)
    if (t) extra += Number(t.price || 0)
  }
  return Number(basePrice || 0) + extra
}

export function validateRequiredGroups(groups, selectedToppingIds) {
  for (const g of groups || []) {
    if (g.required) {
      const hasSelection = (g.toppings || []).some((t) => selectedToppingIds.includes(t.id))
      if (!hasSelection) return false
    }
  }
  return true
}

/** First missing required group (for a helpful "اختر كذا" message). */
export function firstMissingGroup(groups, selectedToppingIds) {
  for (const g of groups || []) {
    if (!g.required) continue
    const hasSelection = (g.toppings || []).some((t) => selectedToppingIds.includes(t.id))
    if (!hasSelection) return g
  }
  return null
}

export function adminKeyboard() {
  return Markup.keyboard([
    ['📋 View Orders', '🍽 Manage Menu'],
    ['👤 Manage Staff', '🕐 Manage Slots'],
    ['📊 Analytics', '📢 Broadcast'],
    ['🧹 Clear Chat']
  ]).resize()
}

export function studentKeyboard() {
  return Markup.keyboard([
    ['🍽 تصفح المنيو', '🛒 سلتي'],
    ['📦 طلباتي', '❓ مساعدة']
  ]).resize()
}

export function cashierKeyboard() {
  return Markup.keyboard([
    ['📋 الطلبات النشطة'],
    ['🔍 البحث عن طلب']
  ]).resize()
}
