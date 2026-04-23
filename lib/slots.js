import supabase from './supabase.js'

export async function getAvailableSlots() {
  // Get all active slots
  const { data: slots, error } = await supabase
    .from('pickup_slots')
    .select('*')
    .eq('is_active', true)
    .order('slot_time')

  if (error) {
    console.error('Error fetching slots:', error.message)
    return []
  }

  if (!slots) return []

  // For each slot, count today's confirmed orders
  const today = new Date().toISOString().split('T')[0]

  const slotsWithCount = await Promise.all(slots.map(async (slot) => {
    const { count, error: countError } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('slot_id', slot.id)
      .neq('status', 'cancelled')
      .gte('created_at', `${today}T00:00:00`)
      .lte('created_at', `${today}T23:59:59`)

    if (countError) {
      console.error(`Error counting orders for slot ${slot.id}:`, countError.message)
    }

    return {
      ...slot,
      current_orders: count || 0,
      spots_left: slot.max_orders - (count || 0),
      is_full: (count || 0) >= slot.max_orders
    }
  }))

  return slotsWithCount.filter(s => !s.is_full)
}
