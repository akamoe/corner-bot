import supabase from './supabase.js'

export async function getAvailableSlots() {
  // Get all active slots
  const { data: slots, error } = await supabase
    .from('pickup_slots')
    .select('*')
    .eq('is_active', true)
    .order('slot_time')

  if (error) {
    console.error('[getAvailableSlots] Error fetching slots:', error.message, error)
    return []
  }

  if (!slots?.length) return []

  // Single query: count today's non-cancelled orders grouped by slot_id
  const today = new Date().toISOString().split('T')[0]

  const { data: counts, error: countError } = await supabase
    .from('orders')
    .select('slot_id')
    .neq('status', 'cancelled')
    .gte('created_at', `${today}T00:00:00`)
    .lte('created_at', `${today}T23:59:59`)

  if (countError) {
    console.error('[getAvailableSlots] Error counting orders:', countError.message, countError)
  }

  // Count orders per slot_id in memory — avoids N+1 round-trips
  const countBySlot = new Map()
  for (const o of counts || []) {
    countBySlot.set(o.slot_id, (countBySlot.get(o.slot_id) || 0) + 1)
  }

  return slots
    .map(slot => {
      const currentOrders = countBySlot.get(slot.id) || 0
      return {
        ...slot,
        current_orders: currentOrders,
        spots_left: slot.max_orders - currentOrders,
        is_full: currentOrders >= slot.max_orders
      }
    })
    .filter(s => !s.is_full)
}
