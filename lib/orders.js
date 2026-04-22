import supabase from './supabase.js'
import { calculateTotal } from './cart.js'

export async function confirmOrder(cartId, slotId, notes = null) {
  // Get cart items
  const { data: items } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', cartId)

  const total = calculateTotal(items)

  const { data: order } = await supabase
    .from('orders')
    .update({
      slot_id: slotId,
      status: 'confirmed',
      total_amount: total,
      notes
    })
    .eq('id', cartId)
    .select()
    .single()

  return order
}

export async function updateOrderStatus(orderId, status) {
  const { data } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', orderId)
    .select('*, users(*), pickup_slots(*)')
    .single()

  return data
}

export async function getOrderByCode(orderCode) {
  const { data } = await supabase
    .from('orders')
    .select('*, order_items(*), pickup_slots(*)')
    .eq('order_code', orderCode.toUpperCase())
    .single()

  return data
}

export async function getPendingOrders() {
  const today = new Date().toISOString().split('T')[0]

  const { data } = await supabase
    .from('orders')
    .select('*, order_items(*), pickup_slots(*), users(anonymous_token)')
    .in('status', ['confirmed', 'preparing'])
    .gte('created_at', `${today}T00:00:00`)
    .order('created_at')

  return data || []
}