import supabase from './supabase.js'

// Add item to cart (stored as a pending order in supabase)
export async function getCart(userId) {
  const { data } = await supabase
    .from('orders')
    .select('*, order_items(*, menu_items(*))')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  return data || null
}

export async function getOrCreateCart(userId) {
  const existing = await getCart(userId)
  if (existing) return existing

  const { data } = await supabase
    .from('orders')
    .insert({ user_id: userId, status: 'pending' })
    .select()
    .single()

  return data
}

export async function addItemToCart(userId, menuItem, quantity = 1, customization = null) {
  const cart = await getOrCreateCart(userId)

  // Check if item already in cart
  const { data: existing } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', cart.id)
    .eq('menu_item_id', menuItem.id)
    .single()

  if (existing) {
    await supabase
      .from('order_items')
      .update({ quantity: existing.quantity + quantity })
      .eq('id', existing.id)
  } else {
    await supabase
      .from('order_items')
      .insert({
        order_id: cart.id,
        menu_item_id: menuItem.id,
        item_name: menuItem.name,
        item_price: menuItem.price,
        quantity,
        customization
      })
  }

  return cart
}

export async function removeItemFromCart(userId, orderItemId) {
  await supabase
    .from('order_items')
    .delete()
    .eq('id', orderItemId)
}

export async function clearCart(userId) {
  const cart = await getCart(userId)
  if (!cart) return

  await supabase
    .from('order_items')
    .delete()
    .eq('order_id', cart.id)
}

export function calculateTotal(orderItems) {
  return orderItems.reduce((sum, item) => sum + (item.item_price * item.quantity), 0)
}