import supabase from './supabase.js'

export async function getCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order')

  if (error) {
    console.error('Error fetching categories:', error.message)
    return []
  }

  return data || []
}

export async function getItemsByCategory(categoryId) {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*')
    .eq('category_id', categoryId)
    .eq('is_available', true)
    .order('sort_order')

  if (error) {
    console.error('Error fetching menu items:', error.message)
    return []
  }

  return data || []
}

export async function getMenuItem(itemId) {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle()

  if (error) {
    console.error('Error fetching menu item:', error.message)
    return null
  }

  return data
}
