import supabase from './supabase.js'

// Add item to cart (stored as a pending order in supabase)
export async function getCart(userId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*, menu_items(*))')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .maybeSingle()

  if (error) {
    console.error('[getCart] Error fetching cart for user:', userId, error.message, error)
    return null
  }

  return data
}

export async function getOrCreateCart(userId) {
  const existing = await getCart(userId)
  if (existing) return existing

  const { data, error } = await supabase
    .from('orders')
    .insert({ user_id: userId, status: 'pending' })
    .select()
    .single()

  if (error) {
    console.error('[getOrCreateCart] userId:', userId, error.message, error)
    throw error
  }

  return data
}

export async function addItemToCart(userId, menuItem, quantity = 1, customization = null) {
  const cart = await getOrCreateCart(userId)

  // For items with customization, always insert new row (don't merge)
  if (customization) {
    const { error: insertError } = await supabase
      .from('order_items')
      .insert({
        order_id: cart.id,
        menu_item_id: menuItem.id,
        item_name: menuItem.name,
        item_price: menuItem.price,
        quantity,
        customization
      })

    if (insertError) {
      console.error('[addItemToCart] insert with customization userId:', userId, 'menuItem:', menuItem.id, insertError.message, insertError)
      throw insertError
    }
    return cart
  }

  // Check if item already in cart (simple case, no customization)
  const { data: existing, error: findError } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', cart.id)
    .eq('menu_item_id', menuItem.id)
    .is('customization', null)
    .maybeSingle()

  if (findError) {
    console.error('[addItemToCart] find existing userId:', userId, 'menuItem:', menuItem.id, findError.message, findError)
    throw findError
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from('order_items')
      .update({ quantity: existing.quantity + quantity })
      .eq('id', existing.id)

    if (updateError) {
      console.error('[addItemToCart] update quantity orderItem:', existing.id, updateError.message, updateError)
      throw updateError
    }
  } else {
    const { error: insertError } = await supabase
      .from('order_items')
      .insert({
        order_id: cart.id,
        menu_item_id: menuItem.id,
        item_name: menuItem.name,
        item_price: menuItem.price,
        quantity,
        customization
      })

    if (insertError) {
      console.error('[addItemToCart] insert new userId:', userId, 'menuItem:', menuItem.id, insertError.message, insertError)
      throw insertError
    }
  }

  return cart
}

export async function updateCartItemQuantity(orderItemId, delta) {
  const { data: item, error: fetchError } = await supabase
    .from('order_items')
    .select('quantity')
    .eq('id', orderItemId)
    .maybeSingle()

  if (fetchError) {
    console.error('[updateCartItemQuantity] orderItemId:', orderItemId, fetchError.message, fetchError)
    throw fetchError
  }
  if (!item) return null

  const newQty = item.quantity + delta
  if (newQty <= 0) {
    return removeItemFromCartById(orderItemId)
  }

  const { error } = await supabase
    .from('order_items')
    .update({ quantity: newQty })
    .eq('id', orderItemId)

  if (error) {
    console.error('[updateCartItemQuantity] update orderItemId:', orderItemId, error.message, error)
    throw error
  }

  return newQty
}

export async function removeItemFromCart(userId, orderItemId) {
  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('id', orderItemId)

  if (error) {
    console.error('[removeItemFromCart] userId:', userId, 'orderItemId:', orderItemId, error.message, error)
    throw error
  }
}

// Alias for clarity — same function
export const removeItemFromCartById = removeItemFromCart

export async function clearCart(userId) {
  const cart = await getCart(userId)
  if (!cart) return

  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('order_id', cart.id)

  if (error) {
    console.error('[clearCart] userId:', userId, 'orderId:', cart.id, error.message, error)
    throw error
  }
}

export function calculateTotal(orderItems) {
  return orderItems.reduce((sum, item) => sum + (item.item_price * item.quantity), 0)
}
