# Corner Bot Modularization — Implementation Plan

**Goal:** Split the monolithic 2,250-line `api/webhook.js` into domain-specific handler files, keeping the same behavior unchanged.

**Strategy:** Extract ONE domain at a time, deploy and test each extraction, commit after each. Registration order must be preserved exactly — the handler files register in the same sequence as they currently appear.

**Current registration order (critical to preserve):**
1. setupAdminCommands (from lib/admin-commands.js - imported)
2. setup_commands (bot.command)
3. bot.catch (error handler)
4. /start (bot.start)
5. Admin: View Orders → Analytics
6. Admin: Manage Menu (categories, items, toppings, groups, assignments)
7. Admin: Manage Staff
8. Admin: Manage Slots
9. Admin: Broadcast
10. Admin: Analytics
11. Student: Browse Menu, Customization, Cart, Confirm Order, My Orders
12. Cashier: Active Orders, Status Updates, Order Lookup
13. Commands: /status, /cancel, /cart, /help, ❓ Help
14. Admin: Clear Chat
15. bot.on('text') — multi-step flow handler (MUST be last)
16. Toppings/Groups management (action handlers for admin editing)
17. Webhook export handler

**Tech Stack:** Node.js/ESM, Telegraf, Supabase

---

## Task 1: Create lib/handlers/ directory with shared helpers

**Objective:** Extract reusable helper functions from webhook.js into a shared module so handler files can use them without circular imports.

**Files:**
- Create: `lib/handlers/helpers.js`
- Modify: Keep webhook.js helpers in place for now; migrate after all extracts are done

**Content:**
```javascript
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
```

**Verify:** `node --input-type=module -e "import('./lib/handlers/helpers.js').then(() => console.log('ok'))"`

**Commit:**
```bash
git add lib/handlers/helpers.js
git commit -m "refactor: create shared helpers module for handler extraction"
```
