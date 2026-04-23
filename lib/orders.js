import supabase from './supabase.js'
import { calculateTotal } from './cart.js'

export async function confirmOrder(cartId, slotId, notes = null) {
  // Get cart items
  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', cartId)

  if (itemsError) {
    console.error('Error fetching order items:', itemsError.message)
    throw itemsError
  }

  const total = calculateTotal(items || [])

  const { data: order, error } = await supabase
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

  if (error) {
    console.error('Error confirming order:', error.message)
    throw error
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
    console.error('Error updating order status:', error.message)
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
    console.error('Error fetching order by code:', error.message)
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
    console.error('Error fetching pending orders:', error.message)
    return []
  }

  return data || []
}
