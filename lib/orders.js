/**
 * Order lifecycle: cart -> confirmed order -> preparing -> ready -> picked_up.
 */

import supabase from './supabase.js'
import { calculateTotal } from './cart.js'
import { generateOrderCode, orderCodeCandidates } from './order-code.js'
import { dayRange, todayIso } from './time.js'

export const ORDER_ITEM_EMBED = '*, order_items(*), pickup_slots(*)'

/** Thrown when the chosen pickup slot filled up between picking and confirming. */
export class SlotFullError extends Error {
  constructor(slotLabel) {
    super(`Slot full: ${slotLabel || 'unknown'}`)
    this.name = 'SlotFullError'
    this.slotLabel = slotLabel || null
  }
}

const CODE_ATTEMPTS = 20

/**
 * Turn a pending cart into a confirmed order.
 *
 * - mints a unique `ORD-XXXXX` code (retrying on the UNIQUE violation)
 * - refuses to oversell a slot, and rolls the order back if it lost a race
 */
export async function confirmOrder(cartId, slotId, { notes } = {}) {
  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', cartId)

  if (itemsError) {
    console.error('[confirmOrder] Error fetching items for order:', cartId, itemsError.message, itemsError)
    throw itemsError
  }

  if (!items?.length) {
    throw new Error('Cart is empty')
  }

  const total = calculateTotal(items)

  // ── Capacity check before we touch anything ─────────────────
  const { data: slot, error: slotError } = await supabase
    .from('pickup_slots')
    .select('id, label, max_orders, is_active, slot_time')
    .eq('id', slotId)
    .maybeSingle()

  if (slotError) {
    console.error('[confirmOrder] Error fetching slot:', slotId, slotError.message, slotError)
    throw slotError
  }
  if (!slot) throw new Error('Pickup slot not found')

  if (!(await assertSlotHasRoom(slot))) throw new SlotFullError(slot.label)

  const payload = {
    slot_id: slotId,
    status: 'confirmed',
    total_amount: total
  }
  if (notes !== undefined) payload.notes = notes

  // ── Mint a unique code and write the order ───────────────────
  let order = null
  let lastError = null

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const { data, error } = await supabase
      .from('orders')
      .update({ ...payload, order_code: generateOrderCode() })
      .eq('id', cartId)
      .select()
      .single()

    if (!error) {
      order = data
      break
    }

    // 23505 = unique_violation (order_code already taken) — try another code
    if (error.code === '23505') {
      lastError = error
      continue
    }

    console.error('[confirmOrder] cartId:', cartId, 'slotId:', slotId, error.message, error)
    throw error
  }

  if (!order) {
    console.error(
      '[confirmOrder] Could not mint a unique code after',
      CODE_ATTEMPTS,
      'attempts. cartId:',
      cartId,
      lastError?.message
    )
    throw lastError || new Error('Could not generate an order code')
  }

  // ── Lost the race? Roll the order back into the cart ─────────
  const stillHasRoom = await assertSlotHasRoom(slot, { includeThisOrder: true })
  if (!stillHasRoom) {
    await revertToCart(cartId)
    throw new SlotFullError(slot.label)
  }

  return order
}

/**
 * Returns true when the slot still has room. Never throws: a capacity check
 * that cannot be read must not block a student from ordering.
 *
 * `includeThisOrder` must be true once our own order already sits in the slot
 * (i.e. when re-checking after the write), because the count then includes it.
 */
async function assertSlotHasRoom(slot, { includeThisOrder = false } = {}) {
  const { start, end } = dayRange(todayIso())

  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('slot_id', slot.id)
    .neq('status', 'cancelled')
    .gte('created_at', start)
    .lte('created_at', end)

  if (error) {
    console.error('[assertSlotHasRoom] slotId:', slot.id, error.message, error)
    // Fail open: a capacity query failure must not block a hungry student.
    return true
  }

  const max = Number(slot.max_orders || 0)
  if (!max) return true

  const hasRoom = includeThisOrder ? count <= max : count < max
  if (hasRoom) return true

  console.warn('[assertSlotHasRoom] slot over capacity', { slotId: slot.id, count, max, includeThisOrder })
  return false
}

async function revertToCart(cartId) {
  const { error } = await supabase
    .from('orders')
    .update({ slot_id: null, status: 'pending', total_amount: null, order_code: null })
    .eq('id', cartId)

  if (error) {
    console.error('[revertToCart] Failed to roll back order:', cartId, error.message, error)
  }
}

export async function updateOrderStatus(orderId, status) {
  const { data, error } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', orderId)
    .select('*, users(*), pickup_slots(*)')
    .single()

  if (error) {
    console.error('[updateOrderStatus] orderId:', orderId, 'status:', status, error.message, error)
    throw error
  }

  return data
}

/**
 * Find an order by whatever a cashier/student typed:
 * "ord-7kq2m", "ORD7KQ2M", "7kq2m" or a legacy numeric code like "482".
 */
export async function getOrderByCode(input) {
  const candidates = orderCodeCandidates(input)
  if (!candidates.length) return null

  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from('orders')
      .select(ORDER_ITEM_EMBED)
      .eq('order_code', candidate)
      .maybeSingle()

    if (error) {
      console.error('[getOrderByCode] code:', candidate, error.message, error)
      continue
    }
    if (data) return data
  }

  return null
}

/** One order with items + slot (used before status changes and in cards). */
export async function getOrderById(orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_ITEM_EMBED)
    .eq('id', orderId)
    .maybeSingle()

  if (error) {
    console.error('[getOrderById] orderId:', orderId, error.message, error)
    return null
  }
  return data
}

/** Orders a cashier should act on today: confirmed, preparing and ready. */
export async function getActiveOrders(dateIso = todayIso()) {
  const { start, end } = dayRange(dateIso)

  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*), pickup_slots(*), users(anonymous_token)')
    .in('status', ['confirmed', 'preparing', 'ready'])
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at')

  if (error) {
    console.error('[getActiveOrders] Error fetching active orders:', error.message, error)
    return []
  }

  return data || []
}

/** Last N orders for one user (bot identity). */
export async function getOrdersForUser(userId, limit = 5) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, pickup_slots(label), order_items(*)')
    .eq('user_id', userId)
    .neq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[getOrdersForUser] userId:', userId, error.message, error)
    return []
  }

  return data || []
}

/** The single newest live order for a user (confirmed/preparing/ready). */
export async function getActiveOrderForUser(userId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, pickup_slots(label), order_items(*)')
    .eq('user_id', userId)
    .in('status', ['confirmed', 'preparing', 'ready'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[getActiveOrderForUser] userId:', userId, error.message, error)
    return null
  }

  return data
}

/**
 * A student cancels their own order — only while it is still `confirmed`
 * (once the kitchen starts, only staff can cancel).
 */
export async function cancelOrderByStudent(orderId, userId) {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, order_code, status, user_id')
    .eq('id', orderId)
    .maybeSingle()

  if (error) {
    console.error('[cancelOrderByStudent] orderId:', orderId, error.message, error)
    return { ok: false, reason: 'error' }
  }
  if (!order) return { ok: false, reason: 'missing' }
  if (order.user_id !== userId) return { ok: false, reason: 'forbidden' }
  if (order.status !== 'confirmed') return { ok: false, reason: 'locked', order }

  const { error: updateError } = await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId)

  if (updateError) {
    console.error('[cancelOrderByStudent] orderId:', orderId, updateError.message, updateError)
    return { ok: false, reason: 'error' }
  }

  return { ok: true, order }
}
