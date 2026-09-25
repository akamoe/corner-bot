import supabase from './supabase.js'

// Add item to cart (stored as a pending order in supabase)
export async function getCart(userId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*, menu_items(*))')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[getCart] Error fetching cart for user:', userId, error.message, error)
    throw error
  }

  return data
}

export async function getOrCreateCart(userId) {
  const { data, error } = await supabase.rpc('get_or_create_telegram_cart', { p_user_id: userId })
  if (error) {
    console.error('[getOrCreateCart] userId:', userId, error.message, error)
    throw error
  }
  return data
}

export async function addItemToCart(userId, menuItem, quantity = 1, customization = null) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('INVALID_QUANTITY')
  if (!Number.isInteger(Number(menuItem.price)) || Number(menuItem.price) < 0)
    throw new Error('INVALID_ITEM_PRICE')
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
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: current, error: readError } = await supabase.from('order_items')
        .select('quantity').eq('id', existing.id).eq('order_id', cart.id).maybeSingle()
      if (readError) throw readError
      if (!current) throw new Error('CART_ITEM_CHANGED_RETRY')
      const nextQuantity = Number(current.quantity) + quantity
      if (nextQuantity > 99) throw new Error('QUANTITY_LIMIT')
      const { data, error: updateError } = await supabase.from('order_items')
        .update({ quantity: nextQuantity }).eq('id', existing.id)
        .eq('order_id', cart.id).eq('quantity', current.quantity).select('id')
      if (updateError) throw updateError
      if (data?.length) return cart
    }
    throw new Error('CART_ITEM_CHANGED_RETRY')
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

export async function updateCartItemQuantity(userId, orderItemId, delta) {
  if (delta !== 1 && delta !== -1) throw new Error('INVALID_QUANTITY_CHANGE')
  const cart = await getCart(userId)
  if (!cart) throw new Error('CART_NOT_FOUND')
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: item, error: fetchError } = await supabase
      .from('order_items').select('quantity').eq('id', orderItemId)
      .eq('order_id', cart.id).maybeSingle()
    if (fetchError) throw fetchError
    if (!item) throw new Error('ITEM_NOT_IN_OWN_CART')
    const newQty = Number(item.quantity) + delta
    if (newQty <= 0) {
      await removeItemFromCart(userId, orderItemId)
      return null
    }
    if (newQty > 99) throw new Error('QUANTITY_LIMIT')
    const { data, error } = await supabase.from('order_items')
      .update({ quantity: newQty }).eq('id', orderItemId)
      .eq('order_id', cart.id).eq('quantity', item.quantity).select('id')
    if (error) throw error
    if (data?.length) return newQty
  }
  throw new Error('QUANTITY_CHANGED_RETRY')
}

export async function removeItemFromCart(userId, orderItemId) {
  const cart = await getCart(userId)
  if (!cart) throw new Error('CART_NOT_FOUND')
  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('id', orderItemId)
    .eq('order_id', cart.id)

  if (error) {
    console.error('[removeItemFromCart] userId:', userId, 'orderItemId:', orderItemId, error.message, error)
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
    console.error('[clearCart] userId:', userId, 'orderId:', cart.id, error.message, error)
    throw error
  }
}

export function calculateTotal(orderItems) {
  return orderItems.reduce((sum, item) => sum + (item.item_price * item.quantity), 0)
}
