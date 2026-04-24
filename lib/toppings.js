import supabase from './supabase.js'

/**
 * Fetch topping groups linked to a menu item, with their toppings.
 */
export async function getItemToppingGroups(menuItemId) {
  const { data: itemGroups, error } = await supabase
    .from('item_topping_groups')
    .select('group_id, topping_groups(id, name, selection_type, required)')
    .eq('menu_item_id', menuItemId)

  if (error) {
    console.error('Error fetching item topping groups:', error.message)
    return []
  }

  const groups = []
  for (const ig of (itemGroups || [])) {
    const group = ig.topping_groups
    if (!group) continue

    const { data: options } = await supabase
      .from('topping_group_options')
      .select('topping_id, toppings(id, name, price, is_active)')
      .eq('group_id', group.id)

    groups.push({
      ...group,
      toppings: (options || [])
        .map(o => o.toppings)
        .filter(Boolean)
        .filter(t => t.is_active !== false)
    })
  }

  return groups
}

/**
 * Fetch all toppings.
 */
export async function getAllToppings(activeOnly = false) {
  let q = supabase.from('toppings').select('*').order('name')
  if (activeOnly) q = q.eq('is_active', true)

  const { data, error } = await q
  if (error) {
    console.error('Error fetching toppings:', error.message)
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
    console.error('Error fetching topping groups:', error.message)
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
