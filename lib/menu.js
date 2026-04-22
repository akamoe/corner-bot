import supabase from './supabase.js'

export async function getCategories() {
  const { data } = await supabase
    .from('categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order')

  return data || []
}

export async function getItemsByCategory(categoryId) {
  const { data } = await supabase
    .from('menu_items')
    .select('*')
    .eq('category_id', categoryId)
    .eq('is_available', true)
    .order('sort_order')

  return data || []
}

export async function getMenuItem(itemId) {
  const { data } = await supabase
    .from('menu_items')
    .select('*')
    .eq('id', itemId)
    .single()

  return data
}