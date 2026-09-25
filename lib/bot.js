/**
 * Bot assembly.
 *
 * This bot serves customers only. Customers browse the menu, build a cart and
 * check out. Staff operations live in the website dashboard.
 *
 * Everything that used to live in `api/webhook.js` lives here so that:
 *   - `api/webhook.js` is a thin Vercel entry point
 *   - `scripts/dev.js` can launch the very same bot for local testing
 *   - tests can import and drive it without an HTTP server
 *
 * Registration order matters: specific handlers first, catch-all `bot.on('text')`
 * last (see SKILL.md §2).
 */

import { Telegraf, Markup } from 'telegraf'
import { getOrCreateUser } from './auth.js'
import { removeItemFromCart } from './cart.js'
import { getActiveOrderForUser } from './orders.js'
import { latestPaymentForUser, waylConfig } from './wayl.js'
import { safeCheckoutUrl } from './wayl-core.js'
import { orderFlowState } from './state.js'

import { setupStudentMenu, showCategories } from './handlers/student-menu.js'
import { setupStudentCart, showCart } from './handlers/student-cart.js'
import { setupStudentOrders } from './handlers/student-orders.js'
import { studentKeyboard, studentOrderCard, safeReply } from './handlers/helpers.js'

export const COMMANDS = [
  { command: 'start', description: 'البداية / Start' },
  { command: 'menu', description: 'تصفح المنيو' },
  { command: 'cart', description: 'سلتي' },
  { command: 'status', description: 'حالة طلبي' },
  { command: 'help', description: 'مساعدة' },
  { command: 'cancel', description: 'إلغاء العملية الحالية' }
]

export function createBot(token = process.env.BOT_TOKEN, options = undefined) {
  if (!token) {
    throw new Error('BOT_TOKEN is not set — the bot cannot start')
  }

  const bot = new Telegraf(token, options)

  // ─── DOMAIN HANDLERS (order matters) ─────────────────────────
  setupStudentMenu(bot)
  setupStudentCart(bot)
  setupStudentOrders(bot)

  // ─── GLOBAL ERROR HANDLER ────────────────────────────────────

  bot.catch((err, ctx) => {
    const info = ctx ? `userId=${ctx.from?.id} chatId=${ctx.chat?.id}` : 'no ctx'
    console.error(`[bot.catch] ${info}:`, err?.stack || err)
    ctx
      ?.reply('⚠️ صار خطأ غير متوقع. جرب مرة ثانية.\nاذا استمرت المشكلة كلم الإدارة.')
      .catch((e) => console.error('[bot.catch] failed to reply:', e.message))
  })

  // ─── /start ──────────────────────────────────────────────────

  bot.start(async (ctx) => {
    await orderFlowState.delete(ctx.from.id)

    return ctx.reply(
      '🌽 أهلاً بيك بـ *Corner*!\n\n' +
        'اطلب مسبقاً وما تنطر — نجهزه بأعلى طعم.\n\n' +
        'اختار من الأزرار تحت 👇',
      { parse_mode: 'Markdown', ...studentKeyboard() }
    )
  })

  // ─── COMMANDS ────────────────────────────────────────────────

  bot.command('status', async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    const order = await getActiveOrderForUser(user.id)

    if (!order) {
      const payment = await latestPaymentForUser(user.id)
      if (payment?.status === 'pending') {
        const rows = []
        if (waylConfig() && payment.checkout_url) {
          try { rows.push([Markup.button.url('🔗 افتح رابط الدفع', safeCheckoutUrl(payment.checkout_url))]) }
          catch { /* Never show an untrusted URL. */ }
        }
        rows.push([Markup.button.callback('🔄 تحقق من الدفع', 'wayl_status')])
        return safeReply(ctx,
          `⏳ الدفع بعده قيد الانتظار.\n🕐 الاستلام: ${payment.pickup_slots?.label || 'الوقت المختار'}` +
          '\nالطلب ما وصل للمطبخ بعد.',
          { ...Markup.inlineKeyboard(rows) })
      }
      if (payment?.status === 'paid' && payment.environment === 'test') {
        return safeReply(ctx, '🧪 الدفع التجريبي تأكد. ما انرسل طلب للمطبخ.')
      }
      return safeReply(
        ctx,
        '📦 ما عندك طلب نشط هسة.\n\nتصفح المنيو واطلب 🌽',
        { ...Markup.inlineKeyboard([[Markup.button.callback('🍽 تصفح المنيو', 'catroot')]]) }
      )
    }

    const payment = await latestPaymentForUser(user.id)
    const paymentLine = payment?.cart_id === order.id && payment.status === 'refunded'
      ? '\n\n↩️ حالة الدفع: المبلغ انرجع. كلمنا بالكاونتر عن حالة الطلب.'
      : payment?.cart_id === order.id && payment.status === 'paid'
        ? '\n\n💳 حالة الدفع: تأكد.' : ''
    return safeReply(ctx, `${studentOrderCard(order)}${paymentLine}`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 تحديث الحالة', 'my_orders')],
        [Markup.button.callback('🍽 تصفح المنيو', 'catroot')]
      ])
    })
  })

  bot.command('menu', async (ctx) => {
    await showCategories(ctx)
  })

  bot.command('cart', async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    await showCart(ctx, user.id, ctx.from.id)
  })

  bot.command('help', async (ctx) => {
    await safeReply(ctx, helpText())
  })

  bot.hears(['❓ مساعدة', '❓ Help'], async (ctx) => {
    await safeReply(ctx, helpText())
  })

  bot.command('cancel', async (ctx) => {
    const hadOrder = await orderFlowState.has(ctx.from.id)
    await orderFlowState.delete(ctx.from.id)
    return ctx.reply(hadOrder ? '❌ ألغينا العملية الحالية.' : 'ماكو شي نلغيه.')
  })

  // ─── LEGACY CART BUTTON (old messages still in students' chats) ──

  bot.action(/^remove_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, async (ctx) => {
    const user = await getOrCreateUser(ctx.from.id)
    await removeItemFromCart(user.id, ctx.match[1])
    await ctx.answerCbQuery('انشال من السلة.').catch(() => {})
    await ctx.deleteMessage().catch(() => {})
  })

  // ════════════════════════════════════════════════════════════
  // TEXT HANDLER — registered LAST
  // ════════════════════════════════════════════════════════════

  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim()

    // Someone is in the middle of a form. The form handler consumes the text.
    if (await orderFlowState.has(ctx.from.id)) return

    // Point people back to the buttons instead of silently ignoring them.
    if (text.startsWith('/')) return

    return ctx.reply('🤔 ما فهمت عليك.\n\nاختار من الأزرار تحت 👇', studentKeyboard())
  })

  return bot
}

function helpText() {
  return (
    '❓ *مساعدة — Corner Bot*\n\n' +
    '🍽 *تصفح المنيو* — شوف الوجبات وأسعارها وخصص وجبتك\n' +
    '🛒 *سلتي* — عدل الكميات واختار وقت الاستلام وطريقة الدفع\n' +
    '📦 *طلباتي* — تابع حالة طلبك أو الغيه\n' +
    '🕐 *وقت الاستلام* — تختاره وقت تأكيد الطلب\n\n' +
    'بالدفع النقدي يتأكد الطلب مباشرة. بالدفع الإلكتروني انتظر رسالة تأكيد الدفع من البوت.\n' +
    'اذا مكتوب تجربة، الدفع اختبار وما ينرسل الطلب للمطبخ.\n' +
    'بعد تأكيد الطلب راح يطلعلك *رمز* (مثل ORD-7KQ2M). وريه عند الكاونتر.\n' +
    'وراح يوصلك إشعار لما يجهز طلبك 🌽\n\n' +
    'عندك سؤال؟ زورنا بـ Corner بالحرم الجامعي.'
  )
}

// Vercel/serverless entry points reuse one instance per warm container.
export const bot = createBot()

export default bot
