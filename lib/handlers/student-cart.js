import { Markup } from 'telegraf'
import { getOrCreateUser } from '../auth.js'
import { getCart, addItemToCart, removeItemFromCart, clearCart, updateCartItemQuantity } from '../cart.js'
import { getAvailableSlots } from '../slots.js'
import { confirmOrder } from '../orders.js'
import { notifyCashiers, notifyStudent } from '../notifications.js'
import { parseCustomization } from '../toppings.js'
import { formatOrderSummary } from './helpers.js'
import supabase from '../supabase.js'

export function setupStudentCart(bot) {
  // ─── CART ────────────────────────────────────────────────────

  bot.hears(['🛒 سلتي', '🛒 My Cart'], async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const cart = await getCart(user.id)

    if (!cart || !cart.order_items?.length) {
      return ctx.reply(
        '🛒 سلتك فاضية.\n\nتصفح المنيو وأضف وجبات!',
        Markup.keyboard([
          ['🍽 تصفح المنيو', '🛒 سلتي'],
          ['📦 طلباتي', '❓ مساعدة']
        ]).resize()
      )
    }

    const items = cart.order_items
    const total = items.reduce((s, i) => s + i.item_price * i.quantity, 0)
    const summary = formatOrderSummary(items)

    await ctx.reply(
      `🛒 *سلتك*\n\n${summary}\n\n*المجموع: ${total.toFixed(2)} IQD*`,
      { parse_mode: 'Markdown' }
    )

    for (const i of items) {
      const custom = parseCustomization(i.customization)
      const toppingNames = custom.toppings.map(t => t.name).join(', ')
      let text = `• ${i.item_name}\n`
      if (toppingNames) text += `  🧀 ${toppingNames}\n`
      text += `  💰 ${i.item_price.toFixed(2)} IQD × ${i.quantity}`

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('➕', `cart_qty_up_${i.id}`),
            Markup.button.callback('➖', `cart_qty_down_${i.id}`),
            Markup.button.callback('❌ إزالة', `cart_rm_${i.id}`)
          ]
        ])
      })
    }

    await ctx.reply(
      'استمر بالتعديل أو أكد الطلب:',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ تأكيد الطلب', 'confirm_order')],
        [Markup.button.callback('🗑 تفريغ السلة', 'clear_cart')]
      ])
    )
  })

  // ─── CART ITEM CONTROLS ──────────────────────────────────────

  bot.action(/^cart_qty_up_(.+)$/, async (ctx) => {
    const orderItemId = ctx.match[1]
    await updateCartItemQuantity(orderItemId, 1)
    await ctx.answerCbQuery('تمت الزيادة.')
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ تم التحديث')
  })

  bot.action(/^cart_qty_down_(.+)$/, async (ctx) => {
    const orderItemId = ctx.match[1]
    const newQty = await updateCartItemQuantity(orderItemId, -1)
    await ctx.answerCbQuery('تم النقصان.')
    if (newQty === null) {
      await ctx.deleteMessage()
    } else {
      await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ تم التحديث')
    }
  })

  bot.action(/^cart_rm_(.+)$/, async (ctx) => {
    const orderItemId = ctx.match[1]
    try {
      await removeItemFromCart(null, orderItemId)
      await ctx.answerCbQuery('تم الحذف.')
      await ctx.deleteMessage()
    } catch (err) {
      console.error('cart_rm_ error:', err.message)
      await ctx.answerCbQuery('❌ فشل الحذف، جرب ثاني.')
    }
  })

  bot.action('clear_cart', async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    await clearCart(user.id)
    await ctx.answerCbQuery('تم التفريغ.')
    await ctx.editMessageText('🗑 تم تفريغ سلتك.')
  })

  // ─── CONFIRM ORDER → PICK SLOT ───────────────────────────────

  bot.action('confirm_order', async (ctx) => {
    await ctx.answerCbQuery()
    const slots = await getAvailableSlots()

    if (!slots.length) {
      return ctx.reply('⚠️ ما في أوقات استلام متاحة هسة. جرب بعدين.')
    }

    const buttons = slots.map(s => [
      Markup.button.callback(
        `🕐 ${s.label} — ${s.spots_left} مكان متبقي`,
        `slot_${s.id}`
      )
    ])

    await ctx.reply(
      '📅 *اختار وقت الاستلام:*',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      }
    )
  })

  bot.action(/^slot_(.+)$/, async (ctx) => {
    const slotId = ctx.match[1]
    const user = await getOrCreateUser(ctx.from.id)
    const cart = await getCart(user.id)

    if (!cart || !cart.order_items?.length) {
      return ctx.answerCbQuery('سلتك فاضية.')
    }

    await ctx.answerCbQuery()
    const order = await confirmOrder(cart.id, slotId)

    const { data: slot, error: slotError } = await supabase
      .from('pickup_slots')
      .select('label')
      .eq('id', slotId)
      .maybeSingle()

    if (slotError) {
      console.error('Error fetching slot:', slotError.message)
    }

    await ctx.reply(
      `✅ *تم تأكيد طلبك!*\n\n` +
      `🎫 رمز طلبك: *${order.order_code}*\n` +
      `🕐 وقت الاستلام: *${slot?.label || 'N/A'}*\n\n` +
      `وريهم هذا الرمز عند الكاونتر لمن توصل.\n` +
      `راح تجيك إشعار لما يجهز طلبك!`,
      { parse_mode: 'Markdown' }
    )

    await notifyCashiers(bot, order)
  })
}
