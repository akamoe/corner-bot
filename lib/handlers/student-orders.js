import { Markup } from 'telegraf'
import { getOrCreateUser } from '../auth.js'
import supabase from '../supabase.js'

export function setupStudentOrders(bot) {
  bot.hears(['📦 طلباتي', '📦 My Orders'], async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)

    const { data: orders, error } = await supabase
      .from('orders')
      .select('*, pickup_slots(label), order_items(*)')
      .eq('user_id', user.id)
      .neq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(5)

    if (error) {
      console.error('[studentOrders] Error fetching orders for user:', user.id, error.message, error)
      return ctx.reply('⚠️ ما قدرنا نحمل طلباتك. جرب ثاني.')
    }

    if (!orders?.length) {
      return ctx.reply('ما عندك طلبات سابقة.')
    }

    const statusEmoji = {
      confirmed: '✅',
      preparing: '👨‍🍳',
      ready: '🔔',
      picked_up: '✔️',
      cancelled: '❌'
    }

    const statusAr = {
      confirmed: 'مؤكد',
      preparing: 'يتحضر',
      ready: 'جاهز',
      picked_up: 'تم الاستلام',
      cancelled: 'ملغي'
    }

    const text = orders.map(o =>
      `${statusEmoji[o.status] || '•'} *${o.order_code}* — ${statusAr[o.status] || o.status}\n` +
      `🕐 ${o.pickup_slots?.label || 'N/A'} | 💰 ${o.total_amount?.toFixed(2)} IQD`
    ).join('\n\n')

    await ctx.reply(`📦 *طلباتك الأخيرة*\n\n${text}`, { parse_mode: 'Markdown' })
  })
}
