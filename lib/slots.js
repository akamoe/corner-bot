/**
 * Pickup slots.
 *
 * Slots are daily recurring (`slot_time` is a time, not a timestamp), so
 * "available" means: active, still in the future today, and not full of
 * today's non-cancelled orders.
 */

import supabase from './supabase.js'
import { dayRange, todayIso, isSlotTimePast } from './time.js'
import { reconcileExpiredPayments } from './wayl.js'

/** All active slots, ordered by time. */
export async function getActiveSlots() {
  const { data, error } = await supabase
    .from('pickup_slots')
    .select('*')
    .eq('is_active', true)
    .order('slot_time')

  if (error) {
    console.error('[getActiveSlots] Error fetching slots:', error.message, error)
    throw error
  }

  return data || []
}

/**
 * Orders per slot_id for a local calendar day, in ONE query.
 * (The previous version built a UTC day window, which broke after 21:00 UTC.)
 */
export async function countOrdersBySlot(dateIso = todayIso()) {
  const { start, end } = dayRange(dateIso)

  const { data, error } = await supabase
    .from('orders')
    .select('slot_id')
    .neq('status', 'cancelled')
    .gte('created_at', start)
    .lte('created_at', end)

  if (error) {
    console.error('[countOrdersBySlot] dateIso:', dateIso, error.message, error)
    throw error
  }

  const counts = new Map()
  for (const row of data || []) {
    if (!row.slot_id) continue
    counts.set(row.slot_id, (counts.get(row.slot_id) || 0) + 1)
  }
  return counts
}

/** Slots a student can actually pick right now (not past, not full). */
export async function getAvailableSlots(date = new Date()) {
  await reconcileExpiredPayments()
  const slots = await getActiveSlots()
  if (!slots.length) return []

  const counts = await countOrdersBySlot(todayIso(date))

  return slots
    .map((slot) => {
      const current = counts.get(slot.id) || 0
      return {
        ...slot,
        current_orders: current,
        max_orders: Number(slot.max_orders || 0),
        spots_left: Number(slot.max_orders || 0) > 0
          ? Math.max(0, Number(slot.max_orders) - current) : null
      }
    })
    .filter((slot) => !isSlotTimePast(slot.slot_time, date)
      && (slot.spots_left === null || slot.spots_left > 0))
}

/**
 * Can this slot be booked right now?
 * Returns { ok: true, slot, spotsLeft } or { ok: false, reason } where reason
 * is one of: missing | inactive | past | full.
 */
export async function getSlotBookability(slotId, date = new Date()) {
  const { data: slot, error } = await supabase
    .from('pickup_slots')
    .select('*')
    .eq('id', slotId)
    .maybeSingle()

  if (error) {
    console.error('[getSlotBookability] slotId:', slotId, error.message, error)
    throw error
  }
  if (!slot) return { ok: false, reason: 'missing' }
  if (slot.is_active === false) return { ok: false, reason: 'inactive', slot }
  if (isSlotTimePast(slot.slot_time, date)) return { ok: false, reason: 'past', slot }

  const counts = await countOrdersBySlot(todayIso(date))
  const current = counts.get(slot.id) || 0
  const max = Number(slot.max_orders || 0)
  if (max > 0 && current >= max) return { ok: false, reason: 'full', slot }

  return { ok: true, slot, spotsLeft: max > 0 ? max - current : null }
}
