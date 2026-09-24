/**
 * Student menu browsing + meal customization.
 *
 * UX rules applied here:
 *  - navigation happens inside ONE message (edit in place), no chat spam
 *  - every button carries its price, so nobody has to open a card to compare
 *  - a meal can always be added: required groups are stated up-front, and the
 *    confirm button says exactly what is missing
 *  - expired sessions never dead-end: they offer a way back to the menu
 */

import { Markup } from 'telegraf'
import { getOrCreateUser } from '../auth.js'
import { orderFlowState } from '../state.js'
import { getCategories, getItemsByCategory, getMenuItem } from '../menu.js'
import { getItemToppingGroups, stringifyCustomization } from '../toppings.js'
import { addItemToCart } from '../cart.js'
import { formatIQD } from '../money.js'
import {
  calculateFinalPrice,
  validateRequiredGroups,
  firstMissingGroup,
  safeReply,
  safeEdit,
  safeRespond
} from './helpers.js'
import { showCart } from './student-cart.js'

const ITEMS_PER_PAGE = 8

// ─── screens ────────────────────────────────────────────────────

export async function showCategories(ctx) {
  const categories = await getCategories()

  if (!categories.length) {
    return safeReply(ctx, '😴 ما في أصناف متاحة هسة.\nرجع لاحقاً أو كلمنا بالكاونتر.')
  }

  const rows = []
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(
      categories.slice(i, i + 2).map((c) =>
        Markup.button.callback(`${c.emoji || '🍴'} ${c.name}`, `cat_${c.id}`)
      )
    )
  }
  rows.push([Markup.button.callback('🛒 سلتي', 'view_cart')])

  return safeRespond(ctx, '📋 *منيونا*\n\nاختار الفئة اللي تحبها:', {
    ...Markup.inlineKeyboard(rows)
  })
}

export async function showCategoryItems(ctx, categoryId, page = 0) {
  const items = await getItemsByCategory(categoryId)

  if (!items.length) {
    return safeRespond(ctx, '😴 ما في وجبات بهاي الفئة هسة.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 الأصناف', 'catroot')]])
    })
  }

  const pages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE))
  const current = Math.min(Math.max(page, 0), pages - 1)
  const slice = items.slice(current * ITEMS_PER_PAGE, current * ITEMS_PER_PAGE + ITEMS_PER_PAGE)

  const rows = slice.map((item) => [
    Markup.button.callback(`🍽 ${item.name} — ${formatIQD(item.price)}`, `item_${item.id}`)
  ])

  if (pages > 1) {
    const nav = []
    if (current > 0) nav.push(Markup.button.callback('⬅️', `catp_${categoryId}_${current - 1}`))
    nav.push(Markup.button.callback(`${current + 1}/${pages}`, 'noop'))
    if (current < pages - 1) nav.push(Markup.button.callback('➡️', `catp_${categoryId}_${current + 1}`))
    rows.push(nav)
  }

  rows.push([
    Markup.button.callback('🔙 الأصناف', 'catroot'),
    Markup.button.callback('🛒 سلتي', 'view_cart')
  ])

  return safeRespond(ctx, '🍽 *اختار وجبتك:*', { ...Markup.inlineKeyboard(rows) })
}

export async function showItemCard(ctx, itemId) {
  const item = await getMenuItem(itemId)
  if (!item) {
    return safeRespond(ctx, '😕 ما لقينا هاي الوجبة.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 الأصناف', 'catroot')]])
    })
  }

  if (item.is_available === false) {
    return safeRespond(ctx, `😕 *${item.name}* خلصت هسة.\nجرب غيرها.`, {
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 الأصناف', 'catroot')]])
    })
  }

  const text =
    `🍽 *${item.name}*\n` +
    (item.description ? `${item.description}\n` : '') +
    `\n💰 ${formatIQD(item.price)}`

  return safeRespond(ctx, text, {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⚙️ خصص وجبتك', `item_${item.id}`)],
      [
        Markup.button.callback('🔙 الأصناف', 'catroot'),
        Markup.button.callback('🛒 سلتي', 'view_cart')
      ]
    ])
  })
}

// ─── customization screen ───────────────────────────────────────

async function sendCustomizationMessage(ctx, userId, { edit = true } = {}) {
  const state = await orderFlowState.get(userId)
  if (!state || state.step !== 'customizing') return

  const { itemName, basePrice, selectedToppings, quantity, groups } = state
  const finalPrice = calculateFinalPrice(basePrice, selectedToppings, groups)
  const extra = finalPrice - Number(basePrice)
  const isEdit = edit && Boolean(ctx.callbackQuery?.message)

  const ordered = [...groups].sort((a, b) => Number(b.required) - Number(a.required))

  let text = `⚙️ *${itemName}*\n`
  text += `💰 ${formatIQD(basePrice)}`
  if (extra > 0) text += ` + ${formatIQD(extra)} إضافات`
  text += ` = *${formatIQD(finalPrice)}*\n`
  text += `🔢 الكمية: ${quantity} — المجموع: *${formatIQD(finalPrice * quantity)}*\n`

  const keyboard = []

  if (!ordered.length) {
    text += '\nماكو إضافات لهاي الوجبة 👍\n'
  }

  for (const group of ordered) {
    const rules = [group.selection_type === 'single' ? 'اختيار واحد' : 'اختيار متعدد']
    if (group.required) rules.push('مطلوب')
    text += `\n📦 *${group.name}* (${rules.join(' · ')})\n`

    for (const t of group.toppings || []) {
      const selected = selectedToppings.includes(t.id)
      const priceTag = Number(t.price || 0) > 0 ? ` (+${formatIQD(t.price)})` : ''
      text += `${selected ? '✅' : '⭕'} ${t.name}${priceTag}\n`
      keyboard.push([
        Markup.button.callback(`${selected ? '✅' : '⭕'} ${t.name}${priceTag}`, `toggle_topping_${t.id}`)
      ])
    }
  }

  keyboard.push([
    Markup.button.callback('➖', 'qty_down'),
    Markup.button.callback(`الكمية: ${quantity}`, 'qty_noop'),
    Markup.button.callback('➕', 'qty_up')
  ])

  const missing = firstMissingGroup(groups, selectedToppings)
  if (missing) {
    keyboard.push([
      Markup.button.callback(`⚠️ اختار من: ${missing.name}`, 'confirm_item_disabled')
    ])
  } else {
    keyboard.push([
      Markup.button.callback(`✅ أضف للسلة — ${formatIQD(finalPrice * quantity)}`, 'confirm_item')
    ])
  }

  keyboard.push([Markup.button.callback('❌ إلغاء', 'cancel_customize')])

  const extra_ = { ...Markup.inlineKeyboard(keyboard) }

  if (isEdit) {
    const edited = await safeEdit(ctx, text, extra_)
    if (edited !== null) return
  }
  return safeReply(ctx, text, extra_)
}

async function expiredSession(ctx, why = 'انتهت الجلسة.') {
  await ctx.answerCbQuery(why).catch(() => {})
  await safeEdit(ctx, '⌛ انتهت الجلسة.\nمنيبلش من جديد؟', {
    ...Markup.inlineKeyboard([[Markup.button.callback('🍽 تصفح المنيو', 'catroot')]])
  })
}

// ─── handlers ───────────────────────────────────────────────────

export function setupStudentMenu(bot) {
  bot.hears(['🍽 تصفح المنيو', '🍽 Browse Menu'], async (ctx) => {
    await showCategories(ctx)
  })

  bot.action('catroot', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await showCategories(ctx)
  })

  bot.action('noop', async (ctx) => ctx.answerCbQuery().catch(() => {}))

  bot.action(/^cat_([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await showCategoryItems(ctx, ctx.match[1], 0)
  })

  bot.action(/^catp_([0-9a-f-]{36})_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    await showCategoryItems(ctx, ctx.match[1], Number(ctx.match[2]))
  })

  bot.action(/^item_([0-9a-f-]{36})$/, async (ctx) => {
    const userId = ctx.from.id
    const itemId = ctx.match[1]

    try {
      await ctx.answerCbQuery().catch(() => {})
      const menuItem = await getMenuItem(itemId)
      if (!menuItem) return safeEdit(ctx, '😕 ما لقينا هاي الوجبة.')

      const groups = await getItemToppingGroups(itemId)

      await orderFlowState.set(userId, {
        step: 'customizing',
        itemId: menuItem.id,
        itemName: menuItem.name,
        basePrice: Number(menuItem.price),
        selectedToppings: [],
        quantity: 1,
        groups
      })

      await sendCustomizationMessage(ctx, userId)
    } catch (err) {
      console.error('[studentMenu] item_ error userId:', userId, 'itemId:', itemId, err)
      await ctx.reply('⚠️ صار خطأ. جرب مرة ثانية.').catch(() => {})
    }
  })

  bot.action(/^toggle_topping_(.+)$/, async (ctx) => {
    const toppingId = ctx.match[1]
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)

    if (!state || state.step !== 'customizing') return expiredSession(ctx)

    const group = state.groups.find((g) => (g.toppings || []).some((t) => t.id === toppingId))
    if (!group) return ctx.answerCbQuery('ما لقينا الإضافة.').catch(() => {})

    const selected = state.selectedToppings.includes(toppingId)

    if (selected) {
      state.selectedToppings = state.selectedToppings.filter((id) => id !== toppingId)
    } else {
      if (group.selection_type === 'single') {
        const groupIds = (group.toppings || []).map((t) => t.id)
        state.selectedToppings = state.selectedToppings.filter((id) => !groupIds.includes(id))
      }
      state.selectedToppings.push(toppingId)
    }

    await orderFlowState.set(userId, state)
    await ctx.answerCbQuery(selected ? 'انشالت' : 'انضافت').catch(() => {})
    await sendCustomizationMessage(ctx, userId)
  })

  bot.action('qty_up', async (ctx) => {
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)
    if (!state || state.step !== 'customizing') return expiredSession(ctx)

    state.quantity = Math.min(state.quantity + 1, 50)
    await orderFlowState.set(userId, state)
    await ctx.answerCbQuery(`الكمية: ${state.quantity}`).catch(() => {})
    await sendCustomizationMessage(ctx, userId)
  })

  bot.action('qty_down', async (ctx) => {
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)
    if (!state || state.step !== 'customizing') return expiredSession(ctx)

    if (state.quantity <= 1) {
      await ctx.answerCbQuery('الحد الأدنى 1').catch(() => {})
    } else {
      state.quantity -= 1
      await orderFlowState.set(userId, state)
      await ctx.answerCbQuery(`الكمية: ${state.quantity}`).catch(() => {})
    }
    await sendCustomizationMessage(ctx, userId)
  })

  bot.action('qty_noop', async (ctx) => ctx.answerCbQuery().catch(() => {}))

  bot.action('confirm_item_disabled', async (ctx) => {
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)
    const missing = state ? firstMissingGroup(state.groups, state.selectedToppings) : null
    return ctx
      .answerCbQuery(missing ? `لازم تختار من: ${missing.name}` : 'أكمل الاختيارات أولاً', { show_alert: true })
      .catch(() => {})
  })

  bot.action('confirm_item', async (ctx) => {
    const userId = ctx.from.id
    const state = await orderFlowState.get(userId)

    if (!state || state.step !== 'customizing') return expiredSession(ctx)

    if (!validateRequiredGroups(state.groups, state.selectedToppings)) {
      const missing = firstMissingGroup(state.groups, state.selectedToppings)
      return ctx.answerCbQuery(`لازم تختار من: ${missing?.name || 'الإضافات'}`, { show_alert: true }).catch(() => {})
    }

    const { itemId, itemName, basePrice, selectedToppings, quantity, groups } = state
    const finalPrice = calculateFinalPrice(basePrice, selectedToppings, groups)

    const allToppings = groups.flatMap((g) => g.toppings || [])
    const selectedToppingsData = selectedToppings.map((tid) => {
      const t = allToppings.find((x) => x.id === tid)
      return { id: tid, name: t?.name || '—', price: Number(t?.price || 0) }
    })

    const user = await getOrCreateUser(userId)

    try {
      await addItemToCart(
        user.id,
        { id: itemId, name: itemName, price: finalPrice },
        quantity,
        stringifyCustomization(selectedToppingsData)
      )
    } catch (err) {
      console.error('[studentMenu] confirm_item addItemToCart failed userId:', userId, err)
      return ctx.answerCbQuery('⚠️ ما قدرنا نضيفها. جرب ثاني.', { show_alert: true }).catch(() => {})
    }

    await orderFlowState.delete(userId)
    await ctx.answerCbQuery('✅ انضافت للسلة').catch(() => {})

    await safeEdit(
      ctx,
      `✅ *${itemName}* انضافت للسلة!\n` +
        `🔢 الكمية: ${quantity}\n` +
        `💰 ${formatIQD(finalPrice * quantity)}`,
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛒 عرض السلة', 'view_cart')],
          [Markup.button.callback('🍽 أضف غرض ثاني', 'catroot')]
        ])
      }
    )
  })

  bot.action('cancel_customize', async (ctx) => {
    await orderFlowState.delete(ctx.from.id)
    await ctx.answerCbQuery('انلغى').catch(() => {})
    await safeEdit(ctx, '❌ لغينا التخصيص.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🍽 تصفح المنيو', 'catroot')]])
    })
  })

  bot.action('view_cart', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {})
    const user = await getOrCreateUser(ctx.from.id)
    await showCart(ctx, user.id, ctx.from.id)
  })
}
