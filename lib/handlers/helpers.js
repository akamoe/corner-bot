import { Markup } from 'telegraf'
import { parseCustomization } from '../toppings.js'

export function formatOrderSummary(items) {
  const lines = items.map(i => {
    const custom = parseCustomization(i.customization)
    const toppingNames = custom.toppings.map(t => t.name).join(', ')
    const toppingLine = toppingNames ? `   └ 🧀 ${toppingNames}` : ''
    return `• ${i.item_name} x${i.quantity} — ${(i.item_price * i.quantity).toFixed(2)} IQD${toppingLine ? '\n' + toppingLine : ''}`
  })
  return lines.join('\n')
}

export function calculateFinalPrice(basePrice, selectedToppingIds, groups) {
  let extra = 0
  const allToppings = groups.flatMap(g => g.toppings)
  for (const tid of selectedToppingIds) {
    const t = allToppings.find(x => x.id === tid)
    if (t) extra += Number(t.price || 0)
  }
  return basePrice + extra
}

export function validateRequiredGroups(groups, selectedToppingIds) {
  for (const g of groups) {
    if (g.required) {
      const hasSelection = g.toppings.some(t => selectedToppingIds.includes(t.id))
      if (!hasSelection) return false
    }
  }
  return true
}

export function isoDay(date) {
  return new Date(date).toISOString().split('T')[0]
}

export function todayIso() {
  return isoDay(new Date())
}

export function daysAgoIso(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDay(d)
}

export function adminKeyboard() {
  return Markup.keyboard([
    ['📋 View Orders', '🍽 Manage Menu'],
    ['👤 Manage Staff', '🕐 Manage Slots'],
    ['📊 Analytics', '📢 Broadcast'],
    ['🧹 Clear Chat']
  ]).resize()
}
