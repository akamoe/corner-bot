import supabase from './supabase.js'

/**
 * Fetch topping groups linked to a menu item, with their toppings.
 * Uses a single batched query instead of N+1 round trips.
 */
export async function getItemToppingGroups(menuItemId) {
  const { data: itemGroups, error } = await supabase
    .from('item_topping_groups')
    .select('group_id, topping_groups(id, name, selection_type, required)')
    .eq('menu_item_id', menuItemId)

  if (error) {
    console.error('[getItemToppingGroups] menuItemId:', menuItemId, error.message, error)
    return []
  }

  const groups = (itemGroups || [])
    .map(ig => ig.topping_groups)
    .filter(Boolean)

  if (!groups.length) return []

  const groupIds = groups.map(g => g.id)

  // Single batched query for all groups instead of one query per group
  const { data: options, error: optError } = await supabase
    .from('topping_group_options')
    .select('group_id, topping_id, toppings(id, name, price, is_active)')
    .in('group_id', groupIds)

  if (optError) {
    console.error('[getItemToppingGroups] Error fetching options for groups:', groupIds, optError.message, optError)
    return groups.map(g => ({ ...g, toppings: [] }))
  }

  // Index options by group_id in memory — no extra DB calls
  const optionsByGroup = new Map()
  for (const opt of (options || [])) {
    if (!opt.toppings || opt.toppings.is_active === false) continue
    if (!optionsByGroup.has(opt.group_id)) optionsByGroup.set(opt.group_id, [])
    optionsByGroup.get(opt.group_id).push(opt.toppings)
  }

  return groups.map(g => ({
    ...g,
    toppings: optionsByGroup.get(g.id) || []
  }))
}

/**
 * Fetch all toppings.
 */
export async function getAllToppings(activeOnly = false) {
  let q = supabase.from('toppings').select('*').order('name')
  if (activeOnly) q = q.eq('is_active', true)

  const { data, error } = await q
  if (error) {
    console.error('[getAllToppings] Error fetching toppings:', error.message, error)
    return []
  }
  return data || []
}

/**
 * Fetch all topping groups.
 */
export async function getAllGroups() {
  const { data, error } = await supabase
    .from('topping_groups')
    .select('*')
    .order('name')

  if (error) {
    console.error('[getAllGroups] Error fetching topping groups:', error.message, error)
    return []
  }
  return data || []
}

/**
 * Parse customization JSON string into object.
 */
export function parseCustomization(jsonStr) {
  if (!jsonStr) return { toppings: [] }
  try {
    return JSON.parse(jsonStr)
  } catch {
    return { toppings: [] }
  }
}

/**
 * Stringify toppings array into customization JSON.
 */
export function stringifyCustomization(toppingsArray) {
  return JSON.stringify({ toppings: toppingsArray })
}
