import { Markup } from 'telegraf'
import { getStaffRole } from '../auth.js'
import { adminFlowState } from '../state.js'
import supabase from '../supabase.js'
import { daysAgoIso, todayIso } from './helpers.js'

async function showOrdersForDay(ctx, day) {
  try {
    const start = `${day}T00:00:00`
    const end = `${day}T23:59:59`

    const { data: orders, error } = await supabase
      .from('orders')
      .select('*, order_items(*), pickup_slots(label), users(anonymous_token)')
      .neq('status', 'pending')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[showOrdersForDay] day:', day, error.message, error)
      return ctx.reply(`❌ Error: ${error.message}`)
    }

    if (!orders?.length) {
      return ctx.reply(
        `📭 No orders for *${day}*.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 Total Sales', `totalsales_${day}`)]
          ])
        }
      )
    }

    await ctx.reply(`📋 *Orders for ${day}* — ${orders.length} order(s)`, { parse_mode: 'Markdown' })

    for (const order of orders) {
      const items = (order.order_items || []).map(i => `• ${i.item_name} x${i.quantity}`).join('\n') || '(no items)'
      const text =
        `🎫 *${order.order_code}*\n` +
        `👤 Token: ${order.users?.anonymous_token || 'N/A'}\n` +
        `🕐 Pickup: ${order.pickup_slots?.label || 'N/A'}\n` +
        `📋 Status: ${String(order.status).toUpperCase()}\n` +
        `💰 ${Number(order.total_amount || 0).toFixed(2)} IQD\n\n` +
        `${items}`
        
      try {
        await ctx.reply(text, { parse_mode: 'Markdown' })
      } catch (err) {
        console.error('[showOrdersForDay] Markdown error for order:', order.order_code, err.message, err)
        await ctx.reply(text.replace(/[*_`\[\]]/g, ''))
      }
    }

    await ctx.reply(
      `✅ End of ${day}`,
      { ...Markup.inlineKeyboard([
        [Markup.button.callback('💰 Total Sales', `totalsales_${day}`)]
      ]) }
    )
  } catch (err) {
    console.error('[showOrdersForDay] Fatal error:', err)
    throw err
  }
}

async function showAnalytics(ctx, days) {
  const from = daysAgoIso(days - 1)
  const start = `${from}T00:00:00`
  const end = `${todayIso()}T23:59:59`

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, status, total_amount, created_at, user_id, order_items(item_name, quantity, item_price)')
    .neq('status', 'pending')
    .gte('created_at', start)
    .lte('created_at', end)

  if (error) return ctx.reply(`❌ ${error.message}`)

  const all = orders || []
  const completed = all.filter(o => o.status !== 'cancelled')
  const cancelled = all.filter(o => o.status === 'cancelled')
  const revenue = completed.reduce((s, o) => s + Number(o.total_amount || 0), 0)
  const uniqueUsers = new Set(completed.map(o => o.user_id)).size

  // Top items
  const itemCounts = new Map()
  for (const o of completed) {
    for (const i of o.order_items || []) {
      const cur = itemCounts.get(i.item_name) || { qty: 0, revenue: 0 }
      cur.qty += i.quantity
      cur.revenue += Number(i.item_price || 0) * i.quantity
      itemCounts.set(i.item_name, cur)
    }
  }
  const topItems = [...itemCounts.entries()]
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 5)
    .map(([name, v], idx) => `${idx + 1}. ${name} — ${v.qty} sold (${v.revenue.toFixed(2)} IQD)`)
    .join('\n') || '(no items sold)'

  const avgOrder = completed.length ? revenue / completed.length : 0

  await ctx.reply(
    `📊 *Analytics — last ${days} day(s)*\n` +
    `(${from} → ${todayIso()})\n\n` +
    `📦 Orders: *${completed.length}* (cancelled: ${cancelled.length})\n` +
    `💵 Revenue: *${revenue.toFixed(2)} IQD*\n` +
    `🧾 Avg order: *${avgOrder.toFixed(2)} IQD*\n` +
    `👥 Unique customers: *${uniqueUsers}*\n\n` +
    `🏆 *Top items*\n${topItems}`,
    { parse_mode: 'Markdown' }
  )
}

export function setupAdminOrders(bot) {
  // ─── VIEW ORDERS ──────────────────────────────────────────────

  bot.hears('📋 View Orders', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

    const buttons = []
    for (let i = 0; i < 7; i++) {
      const day = daysAgoIso(i)
      const label = i === 0 ? `Today (${day})` : i === 1 ? `Yesterday (${day})` : day
      buttons.push([Markup.button.callback(`📅 ${label}`, `vieworders_${day}`)])
    }
    buttons.push([Markup.button.callback('🗓 Custom Date', 'vieworders_custom')])

    await ctx.reply(
      '📋 *View Orders*\n\nSelect a day:',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    )
  })

  bot.action('vieworders_custom', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_orders_date' })
    await ctx.reply('🗓 Send the date you want to view (format: *YYYY-MM-DD*)', { parse_mode: 'Markdown' })
  })

  bot.action(/^vieworders_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const day = ctx.match[1]
    await showOrdersForDay(ctx, day)
  })

  bot.action(/^totalsales_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const day = ctx.match[1]
    const start = `${day}T00:00:00`
    const end = `${day}T23:59:59`

    const { data: orders, error } = await supabase
      .from('orders')
      .select('total_amount, status')
      .neq('status', 'pending')
      .neq('status', 'cancelled')
      .gte('created_at', start)
      .lte('created_at', end)

    if (error) {
      return ctx.reply(`❌ Error: ${error.message}`)
    }

    const totalOrders = orders?.length || 0
    const totalSales = (orders || []).reduce((s, o) => s + Number(o.total_amount || 0), 0)

    await ctx.reply(
      `💰 *Total Sales — ${day}*\n\n` +
      `📦 Orders: *${totalOrders}*\n` +
      `💵 Revenue: *${totalSales.toFixed(2)} IQD*`,
      { parse_mode: 'Markdown' }
    )
  })

  // ─── ANALYTICS ────────────────────────────────────────────────

  bot.hears('📊 Analytics', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.reply('⛔ Unauthorized.')

    await ctx.reply(
      '📊 *Analytics*\n\nChoose a range:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Today', 'analytics_1')],
          [Markup.button.callback('Last 7 days', 'analytics_7')],
          [Markup.button.callback('Last 30 days', 'analytics_30')],
          [Markup.button.callback('Custom (# days)', 'analytics_custom')]
        ])
      }
    )
  })

  bot.action('analytics_custom', async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    await adminFlowState.set(ctx.from.id, { step: 'awaiting_analytics_days' })
    await ctx.reply('🔢 How many days back? Send a positive integer (e.g. 14).')
  })

  bot.action(/^analytics_(\d+)$/, async (ctx) => {
    const role = await getStaffRole(ctx.from.id)
    if (role !== 'admin') return ctx.answerCbQuery('⛔ Unauthorized.')
    await ctx.answerCbQuery()
    const days = parseInt(ctx.match[1], 10)
    await showAnalytics(ctx, days)
  })
}

export { showOrdersForDay, showAnalytics }

