import supabase from './supabase.js'
import { calculateTotal } from './cart.js'

export async function confirmOrder(cartId, slotId, notes = null) {
  // Get cart items
  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', cartId)

  if (itemsError) {
    console.error('[confirmOrder] Error fetching items for order:', cartId, itemsError.message, itemsError)
    throw itemsError
  }

  const total = calculateTotal(items || [])

  // Generate a random order code (1–1000), retry on collision
  let order = null
  let lastError = null
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = String(Math.floor(Math.random() * 1000) + 1)

    const { data, error } = await supabase
      .from('orders')
      .update({
        slot_id: slotId,
        status: 'confirmed',
        total_amount: total,
        notes,
        order_code: code
      })
      .eq('id', cartId)
      .select()
      .single()

    if (!error) {
      order = data
      break
    }

    // 23505 = unique_violation in Postgres — try another code
    if (error.code === '23505') {
      lastError = error
      continue
    }

    // Any other error is fatal
    console.error('[confirmOrder] cartId:', cartId, 'slotId:', slotId, error.message, error)
    throw error
  }

  if (!order) {
    console.error('[confirmOrder] Could not generate unique order code after 10 attempts. cartId:', cartId, lastError?.message, lastError)
    throw lastError
  }

  return order
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

export async function getOrderByCode(orderCode) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*), pickup_slots(*)')
    .eq('order_code', orderCode.toUpperCase())
    .maybeSingle()

  if (error) {
    console.error('[getOrderByCode] code:', orderCode, error.message, error)
    return null
  }

  return data
}

export async function getPendingOrders() {
  const today = new Date().toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*), pickup_slots(*), users(anonymous_token)')
    .in('status', ['confirmed', 'preparing'])
    .gte('created_at', `${today}T00:00:00`)
    .order('created_at')

  if (error) {
    console.error('[getPendingOrders] Error fetching pending orders:', error.message, error)
    return []
  }

  return data || []
}
