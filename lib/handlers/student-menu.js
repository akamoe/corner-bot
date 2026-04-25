import { Markup } from 'telegraf'
import { getOrCreateUser } from '../auth.js'
import { orderFlowState } from '../state.js'
import { getCategories, getItemsByCategory, getMenuItem } from '../menu.js'
import { getItemToppingGroups, parseCustomization, stringifyCustomization } from '../toppings.js'
import { getCart, addItemToCart } from '../cart.js'
import { calculateFinalPrice, validateRequiredGroups } from './helpers.js'

async function sendCustomizationMessage(ctx, userId) {
  const state = await orderFlowState.get(userId)
  if (!state || state.step !== 'customizing') return

  const { itemName, basePrice, selectedToppings, quantity, groups } = state
  const finalPrice = calculateFinalPrice(basePrice, selectedToppings, groups)

  let text = `⚙️ *${itemName}*\n💰 السعر: ${finalPrice.toFixed(2)} IQD × ${quantity} = *${(finalPrice * quantity).toFixed(2)} IQD*\n\n`

  const keyboard = []

  for (const group of groups) {
    text += `📦 *${group.name}* ${group.required ? '(مطلوب)' : ''} [${group.selection_type === 'single' ? 'اختيار واحد' : 'متعدد'}]\n`

    for (const t of group.toppings) {
      const isSelected = selectedToppings.includes(t.id)
      text += `${isSelected ? '✅' : '○'} ${t.name} ${Number(t.price || 0) > 0 ? `(+${Number(t.price).toFixed(2)} IQD)` : ''}\n`
    }

    text += '\n'

    for (const t of group.toppings) {
      const isSelected = selectedToppings.includes(t.id)
      const label = `${isSelected ? '✅' : '⭕'} ${t.name}`
      keyboard.push([Markup.button.callback(label, `toggle_topping_${t.id}`)])
    }
  }

  if (groups.length === 0) {
    text += '(ماكو إضافات متاحة)\n\n'
  }

  // Quantity controls
  keyboard.push([
    Markup.button.callback('➖', 'qty_down'),
    Markup.button.callback(`الكمية: ${quantity}`, 'qty_noop'),
    Markup.button.callback('➕', 'qty_up')
  ])

  // Confirm button (disabled if required groups not satisfied)
  const canConfirm = validateRequiredGroups(groups, selectedToppings)
  if (canConfirm) {
    keyboard.push([Markup.button.callback('✅ أضف للسلة', 'confirm_item')])
  } else {
    keyboard.push([Markup.button.callback(' أكمل الاختيارات المطلوبة', 'confirm_item_disabled')])
  }

  keyboard.push([Markup.button.callback('❌ إلغاء', 'cancel_customize')])

  // Try to edit existing message, otherwise send new
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      })
    } else {
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      })
    }
  } catch (err) {
    console.error('Error sending customization message:', err.message)
    if (err.message.includes('not modified')) {
      return
    }
    await ctx.reply(text.replace(/[*_`\[\]]/g, ''), {
      ...Markup.inlineKeyboard(keyboard)
    }).catch(e => console.error('Fallback reply failed:', e.message))
  }
}

export function setupStudentMenu(bot) {
  // ─── BROWSE MENU ─────────────────────────────────────────────

  bot.hears(['🍽 تصفح المنيو', '🍽 Browse Menu'], async (ctx) => {
    const categories = await getCategories()

    if (!categories.length) {
      return ctx.reply('ما في أصناف متاحة هسة. رجع لاحقاً!')
    }

    const buttons = categories.map(c =>
      [Markup.button.callback(`${c.emoji || '🍴'} ${c.name}`, `cat_${c.id}`)]
    )

    return ctx.reply(
      '📋 *منيونا*\n\nاختار الفئة:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      }
    )
  })

  bot.action(/^cat_(.+)$/, async (ctx) => {
    const categoryId = ctx.match[1]
    const items = await getItemsByCategory(categoryId)

    if (!items.length) {
      return ctx.answerCbQuery('ما في وجبات بهاي الفئة هسة.')
    }

    await ctx.answerCbQuery()

    for (const item of items) {
      const text = `*${item.name}*\n${item.description || ''}\n\n💰 ${item.price.toFixed(2)} IQD`
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ تخصيص الوجبة', `item_${item.id}`)],
        ])
      })
    }
  })

  // ─── CUSTOMIZATION ───────────────────────────────────────────

  bot.action(/^item_(.+)$/, async (ctx) => {
    try {
      const itemId = ctx.match[1]
      const menuItem = await getMenuItem(itemId)

      if (!menuItem) return ctx.answerCbQuery('ما لقينا الوجبة.')

      await ctx.answerCbQuery()

      const groups = await getItemToppingGroups(itemId)

      await orderFlowState.set(ctx.from.id, {
        step: 'customizing',
        itemId: menuItem.id,
        itemName: menuItem.name,
        basePrice: Number(menuItem.price),
        selectedToppings: [],
        quantity: 1,
        groups
      })

      await sendCustomizationMessage(ctx, ctx.from.id)
    } catch (err) {
      console.error('Error in item_ action:', err)
      await ctx.answerCbQuery('حدث خطأ، حاول مرة أخرى.')
    }
  })

  // ─── TOPPING TOGGLES ─────────────────────────────────────────

  bot.action(/^toggle_topping_(.+)$/, async (ctx) => {
    const toppingId = ctx.match[1]
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)

    if (!state || state.step !== 'customizing') {
      return ctx.answerCbQuery('انتهت الجلسة. ابدأ من جديد.')
    }

    const group = state.groups.find(g => g.toppings.some(t => t.id === toppingId))
    if (!group) return ctx.answerCbQuery('Topping not found.')

    const isSelected = state.selectedToppings.includes(toppingId)

    if (isSelected) {
      state.selectedToppings = state.selectedToppings.filter(id => id !== toppingId)
    } else {
      if (group.selection_type === 'single') {
        const groupToppingIds = group.toppings.map(t => t.id)
        state.selectedToppings = state.selectedToppings.filter(id => !groupToppingIds.includes(id))
      }
      state.selectedToppings.push(toppingId)
    }

    await orderFlowState.set(userId, state)
    await ctx.answerCbQuery(isSelected ? 'تم الإلغاء' : 'تم الاختيار')
    await sendCustomizationMessage(ctx, userId)
  })

  // ─── QUANTITY CONTROLS ───────────────────────────────────────

  bot.action('qty_up', async (ctx) => {
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)
    if (!state || state.step !== 'customizing') return ctx.answerCbQuery('Session expired.')
    state.quantity += 1
    await orderFlowState.set(userId, state)
    await ctx.answerCbQuery(`الكمية: ${state.quantity}`)
    await sendCustomizationMessage(ctx, userId)
  })

  bot.action('qty_down', async (ctx) => {
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)
    if (!state || state.step !== 'customizing') return ctx.answerCbQuery('Session expired.')
    if (state.quantity > 1) {
      state.quantity -= 1
      await orderFlowState.set(userId, state)
      await ctx.answerCbQuery(`الكمية: ${state.quantity}`)
    } else {
      await ctx.answerCbQuery('الحد الأدنى 1')
    }
    await sendCustomizationMessage(ctx, userId)
  })

  bot.action('qty_noop', async (ctx) => ctx.answerCbQuery())
  bot.action('confirm_item_disabled', async (ctx) => ctx.answerCbQuery('أكمل الاختيارات المطلوبة أولاً'))

  // ─── CONFIRM CUSTOMIZATION ───────────────────────────────────

  bot.action('confirm_item', async (ctx) => {
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)

    if (!state || state.step !== 'customizing') {
      return ctx.answerCbQuery('انتهت الجلسة.')
    }

    if (!validateRequiredGroups(state.groups, state.selectedToppings)) {
      return ctx.answerCbQuery('أكمل الاختيارات المطلوبة.')
    }

    const { itemId, itemName, basePrice, selectedToppings, quantity, groups } = state
    const finalPrice = calculateFinalPrice(basePrice, selectedToppings, groups)

    const allToppings = groups.flatMap(g => g.toppings)
    const selectedToppingsData = selectedToppings.map(tid => {
      const t = allToppings.find(x => x.id === tid)
      return { id: tid, name: t.name, price: Number(t.price || 0) }
    })

    const customization = stringifyCustomization(selectedToppingsData)

    const menuItem = { id: itemId, name: itemName, price: finalPrice }
    const user = await getOrCreateUser(userId)
    await addItemToCart(user.id, menuItem, quantity, customization)

    await orderFlowState.delete(userId)

    await ctx.answerCbQuery(`✅ ${itemName} انضاف للسلة!`)
    await ctx.editMessageText(
      `✅ *${itemName}* أُضيف للسلة!\nالكمية: ${quantity}\nالسعر: ${(finalPrice * quantity).toFixed(2)} IQD`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.action('cancel_customize', async (ctx) => {
    await orderFlowState.delete(ctx.from.id)
    await ctx.answerCbQuery('تم الإلغاء.')
    await ctx.editMessageText('❌ تم الإلغاء.')
  })
}
