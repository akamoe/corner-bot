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
    console.error('Error fetching cart:', error.message)
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
    console.error('Error creating cart:', error.message)
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
      console.error('Error adding item to cart:', insertError.message)
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
    console.error('Error finding cart item:', findError.message)
    throw findError
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from('order_items')
      .update({ quantity: existing.quantity + quantity })
      .eq('id', existing.id)

    if (updateError) {
      console.error('Error updating cart item:', updateError.message)
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
      console.error('Error adding item to cart:', insertError.message)
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
    console.error('Error fetching cart item:', fetchError.message)
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
    console.error('Error updating quantity:', error.message)
    throw error
  }

  return newQty
}

export async function removeItemFromCartById(orderItemId) {
  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('id', orderItemId)

  if (error) {
    console.error('Error removing item from cart:', error.message)
    throw error
  }
}

export async function removeItemFromCart(userId, orderItemId) {
  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('id', orderItemId)

  if (error) {
    console.error('Error removing item from cart:', error.message)
    throw error
  }
}

export async function clearCart(userId) {
  const cart = await getCart(userId)
  if (!cart) return

  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('order_id', cart.id)

  if (error) {
    console.error('Error clearing cart:', error.message)
    throw error
  }
}

export function calculateTotal(orderItems) {
  return orderItems.reduce((sum, item) => sum + (item.item_price * item.quantity), 0)
}
