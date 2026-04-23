import 'dotenv/config'
import { Telegraf, Markup } from 'telegraf'
import { getOrCreateUser, getStaffRole, hashTelegramId } from '../lib/auth.js'
import { getCategories, getItemsByCategory, getMenuItem } from '../lib/menu.js'
import { getAvailableSlots } from '../lib/slots.js'
import { getCart, addItemToCart, removeItemFromCart, clearCart } from '../lib/cart.js'
import { confirmOrder, updateOrderStatus, getOrderByCode, getPendingOrders } from '../lib/orders.js'
import supabase from '../lib/supabase.js'

const bot = new Telegraf(process.env.BOT_TOKEN)

// Simple in-memory state for admin multi-step flows
const adminFlowState = new Map()

// Register commands with Telegram so they show in the / menu
bot.telegram.setMyCommands([
  { command: 'start', description: 'تشغيل البوت' },
  { command: 'addcashier', description: 'إضافة كاشير (للمشرف فقط)' },
  { command: 'removecashier', description: 'إزالة كاشير (للمشرف فقط)' },
  { command: 'status', description: 'التحقق من طلبك النشط' },
  { command: 'cart', description: 'عرض سلة المشتريات' },
  { command: 'help', description: 'هيلب' }
]).catch(err => console.error('Failed to set commands:', err.message))

// ─── GLOBAL ERROR HANDLER ───────────────────────────────────

bot.catch((err, ctx) => {
  console.error('Telegraf error:', err)
  if (ctx) {
    ctx.reply('اسفين، اكو خطا بس مندري وين. يرجى المحاولة مرة أخرى فد شوية.').catch(console.error)
  }
})

// ─── HELPERS ────────────────────────────────────────────────

function formatOrderSummary(order, items) {
  const lines = items.map(i => `• ${i.item_name} x${i.quantity} — ${(i.item_price * i.quantity).toFixed(2)} د.ع`)
  return lines.join('\n')
}

function isoDay(date) {
  // YYYY-MM-DD
  return new Date(date).toISOString().split('T')[0]
}

function todayIso() {
  return isoDay(new Date())
}

function daysAgoIso(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDay(d)
}

function adminKeyboard() {
  return Markup.keyboard([
    ['📋 عرض الطلبات', '🍽 تعديل المنيو'],
    ['👤 إدارة الموظفين', '🕐 إدارة الأوقات'],
    ['📊 الإحصائيات', '📢 إرسال إعلان']
  ]).resize()
}

// ─── /start ─────────────────────────────────────────────────

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const role = await getStaffRole(ctx.from.id)

  // Cancel any running admin flow when /start is hit
  adminFlowState.delete(ctx.from.id)

  if (role === 'admin') {
    return ctx.reply(
      `👑 الغيمة الثكيلة!\n\nماذا تريد أن تدير؟`,
      adminKeyboard()
    )
  }

  if (role === 'cashier') {
    return ctx.reply(
      `👋 أهلاً بك، أيها الكاشير!\n\nاستخدم الأزرار أدناه لإدارة الطلبات الواردة.`,
      Markup.keyboard([
        ['📋 الطلبات النشطة'],
        ['🔍 البحث عن طلب']
      ]).resize()
    )
  }

  // Regular student
  return ctx.reply(
    `🌽 اهلا بيكم بكورنر!*!\n\ جاهز من تكون أنت جاهز. اطلب مسبقاً وتخطى وقت الانتظار والسرة الطويل.`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        ['🍽 المنيو ', '🛒 سلة المشتريات'],
        ['📦 طلباتي القديمة', '❓ هيلب']
      ]).resize()
    }
  )
})

// ═══════════════════════════════════════════════════════════
// ADMIN HANDLERS — registered BEFORE bot.on('text') so they work
// ═══════════════════════════════════════════════════════════

// ─── ADMIN: VIEW ORDERS ──────────────────────────────────────

bot.hears('📋 عرض الطلبات', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ غير مصرح.')

  const buttons = []
  for (let i = 0; i < 7; i++) {
    const day = daysAgoIso(i)
    const label = i === 0 ? `اليوم (${day})` : i === 1 ? `أمس (${day})` : day
    buttons.push([Markup.button.callback(`📅 ${label}`, `vieworders_${day}`)])
  }
  buttons.push([Markup.button.callback('🗓 تاريخ مخصص', 'vieworders_custom')])

  await ctx.reply(
    '📋 *عرض الطلبات*\n\nاختر يوماً:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  )
})

bot.action('vieworders_custom', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_orders_date' })
  await ctx.reply('🗓 أرسل التاريخ الذي تريد عرضه (التنسيق: *YYYY-MM-DD*)', { parse_mode: 'Markdown' })
})

async function showOrdersForDay(ctx, day) {
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
    console.error('View Orders error:', error.message)
    return ctx.reply(`❌ خطأ: ${error.message}`)
  }

  if (!orders?.length) {
    return ctx.reply(
      `📭 لا توجد طلبات ليوم *${day}*.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💰 إجمالي المبيعات', `totalsales_${day}`)]
        ])
      }
    )
  }

  await ctx.reply(`📋 *طلبات يوم ${day}* — ${orders.length} طلب(ات)`, { parse_mode: 'Markdown' })

  for (const order of orders) {
    const items = order.order_items.map(i => `• ${i.item_name} x${i.quantity}`).join('\n') || '(لا توجد عناصر)'
    const text =
      `🎫 *${order.order_code}*\n` +
      `👤 الرمز: ${order.users?.anonymous_token || 'غير متوفر'}\n` +
      `🕐 الاستلام: ${order.pickup_slots?.label || 'غير متوفر'}\n` +
      `📋 الحالة: ${String(order.status).toUpperCase()}\n` +
      `💰 ${Number(order.total_amount || 0).toFixed(2)} د.ع\n\n` +
      `${items}`
    await ctx.reply(text, { parse_mode: 'Markdown' })
  }

  await ctx.reply(
    `✅ نهاية ${day}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💰 إجمالي المبيعات', `totalsales_${day}`)]
    ])
  )
}

bot.action(/^vieworders_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  const day = ctx.match[1]
  await showOrdersForDay(ctx, day)
})

bot.action(/^totalsales_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
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
    return ctx.reply(`❌ خطأ: ${error.message}`)
  }

  const totalOrders = orders?.length || 0
  const totalSales = (orders || []).reduce((s, o) => s + Number(o.total_amount || 0), 0)

  await ctx.reply(
    `💰 *إجمالي المبيعات — ${day}*\n\n` +
    `📦 الطلبات: *${totalOrders}*\n` +
    `💵 الإيرادات: *${totalSales.toFixed(2)} د.ع*`,
    { parse_mode: 'Markdown' }
  )
})

// ─── ADMIN: MANAGE MENU ──────────────────────────────────────

bot.hears('🍽 إدارة القائمة', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ غير مصرح.')
  await showMenuManagement(ctx)
})

async function showMenuManagement(ctx) {
  await ctx.reply(
    '🍽 *إدارة القائمة*\n\nاختر إجراء:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📖 عرض / تعديل القائمة', 'menu_view')],
        [Markup.button.callback('➕ إضافة عنصر', 'menu_add_item')],
        [Markup.button.callback('➕ إضافة فئة', 'menu_add_category')]
      ])
    }
  )
}

bot.action('menu_view', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()

  const { data: cats, error } = await supabase
    .from('categories')
    .select('*')
    .order('sort_order')

  if (error) return ctx.reply(`❌ خطأ: ${error.message}`)
  if (!cats?.length) return ctx.reply('لا توجد فئات بعد. أضف واحدة أولاً.')

  const buttons = cats.map(c => [
    Markup.button.callback(`${c.emoji || '🍴'} ${c.name}${c.is_active ? '' : ' (مخفي)'}`, `menucat_${c.id}`)
  ])
  buttons.push([Markup.button.callback('⬅️ رجوع', 'menu_back')])

  await ctx.reply('📂 *الفئات*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) })
})

bot.action('menu_back', async (ctx) => {
  await ctx.answerCbQuery()
  await showMenuManagement(ctx)
})

bot.action(/^menucat_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  const catId = ctx.match[1]

  const { data: cat } = await supabase.from('categories').select('*').eq('id', catId).maybeSingle()
  if (!cat) return ctx.reply('الفئة غير موجودة.')

  const { data: items } = await supabase
    .from('menu_items')
    .select('*')
    .eq('category_id', catId)
    .order('sort_order')

  const buttons = (items || []).map(i => [
    Markup.button.callback(`${i.is_available ? '✅' : '❌'} ${i.name} — ${Number(i.price).toFixed(0)} د.ع`, `menuitem_${i.id}`)
  ])
  buttons.push([Markup.button.callback('✏️ إعادة تسمية الفئة', `catrename_${catId}`)])
  buttons.push([Markup.button.callback('🗑 حذف الفئة', `catdelete_${catId}`)])
  buttons.push([Markup.button.callback('⬅️ رجوع', 'menu_view')])

  await ctx.reply(
    `${cat.emoji || '🍴'} *${cat.name}*\n\n${items?.length ? 'اختر عنصراً للتعديل:' : '(لا توجد عناصر في هذه الفئة)'}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  )
})

bot.action(/^menuitem_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  const id = ctx.match[1]
  const { data: item } = await supabase.from('menu_items').select('*').eq('id', id).maybeSingle()
  if (!item) return ctx.reply('العنصر غير موجود.')

  await ctx.reply(
    `*${item.name}*\n${item.description || ''}\n\n💰 ${Number(item.price).toFixed(2)} د.ع\n${item.is_available ? '✅ متاح' : '❌ مخفي'}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ تعديل الاسم', `itemedit_name_${id}`)],
        [Markup.button.callback('💲 تعديل السعر', `itemedit_price_${id}`)],
        [Markup.button.callback(item.is_available ? '🙈 إخفاء' : '👁 إظهار', `itemtoggle_${id}`)],
        [Markup.button.callback('🗑 حذف العنصر', `itemdelete_${id}`)]
      ])
    }
  )
})

bot.action(/^itemedit_name_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_item_name', itemId: ctx.match[1] })
  await ctx.reply('✏️ أرسل *الاسم* الجديد لهذا العنصر.', { parse_mode: 'Markdown' })
})

bot.action(/^itemedit_price_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_item_price', itemId: ctx.match[1] })
  await ctx.reply('💲 أرسل *السعر* الجديد (أرقام فقط).', { parse_mode: 'Markdown' })
})

bot.action(/^itemtoggle_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  const id = ctx.match[1]
  const { data: item } = await supabase.from('menu_items').select('is_available').eq('id', id).maybeSingle()
  if (!item) return ctx.answerCbQuery('غير موجود.')
  const { error } = await supabase.from('menu_items').update({ is_available: !item.is_available }).eq('id', id)
  if (error) return ctx.answerCbQuery(`خطأ: ${error.message}`)
  await ctx.answerCbQuery(item.is_available ? 'مخفي' : 'ظاهر')
  await ctx.reply(item.is_available ? '🙈 تم إخفاء العنصر.' : '👁 تم إظهار العنصر.')
})

bot.action(/^itemdelete_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  const id = ctx.match[1]
  const { error } = await supabase.from('menu_items').delete().eq('id', id)
  if (error) {
    await ctx.answerCbQuery()
    return ctx.reply(`❌ ${error.message}`)
  }
  await ctx.answerCbQuery('تم الحذف')
  await ctx.reply('🗑 تم حذف العنصر.')
})

bot.action(/^catrename_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_category_rename', categoryId: ctx.match[1] })
  await ctx.reply('✏️ أرسل *الاسم* الجديد لهذه الفئة.', { parse_mode: 'Markdown' })
})

bot.action(/^catdelete_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  const id = ctx.match[1]
  const { error } = await supabase.from('categories').delete().eq('id', id)
  if (error) {
    await ctx.answerCbQuery()
    return ctx.reply(`❌ ${error.message}\n(قد تحتاج لحذف العناصر داخلها أولاً.)`)
  }
  await ctx.answerCbQuery('تم الحذف')
  await ctx.reply('🗑 تم حذف الفئة.')
})

bot.action('menu_add_category', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_new_category_name' })
  await ctx.reply('➕ أرسل *اسم* الفئة الجديدة (يمكنك إضافة إيموجي في البداية مثل "🍕 بيتزا").', { parse_mode: 'Markdown' })
})

bot.action('menu_add_item', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()

  const { data: cats } = await supabase.from('categories').select('*').order('sort_order')
  if (!cats?.length) return ctx.reply('لا توجد فئات. أضف فئة أولاً.')

  const buttons = cats.map(c => [Markup.button.callback(`${c.emoji || '🍴'} ${c.name}`, `addtocat_${c.id}`)])
  await ctx.reply('أي فئة تريد إضافة العنصر إليها؟', Markup.inlineKeyboard(buttons))
})

bot.action(/^addtocat_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_new_item_name', categoryId: ctx.match[1] })
  await ctx.reply('➕ أرسل *اسم* العنصر الجديد.', { parse_mode: 'Markdown' })
})

// ─── ADMIN: MANAGE STAFF ─────────────────────────────────────

bot.hears('👤 إدارة الموظفين', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ غير مصرح.')

  await ctx.reply(
    '👤 *إدارة الموظفين*\n\nاختر إجراء:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ إضافة كاشير', 'add_cashier_btn')],
        [Markup.button.callback('🗑 إزالة كاشير', 'remove_cashier_btn')],
        [Markup.button.callback('📋 قائمة الكاشيرات', 'list_cashiers_btn')]
      ])
    }
  )
})

bot.action('add_cashier_btn', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_cashier_id' })
  await ctx.reply(
    '👤 *إضافة كاشير*\n\n' +
    'الخطوة 1 من 2: يرجى إرسال *معرف تليجرام* الخاص بالكاشير (رقمي).\n\n' +
    '💡 تلميح: اطلب منه مراسلة @userinfobot للحصول على معرفه.',
    { parse_mode: 'Markdown' }
  )
})

bot.action('remove_cashier_btn', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_remove_id' })
  await ctx.reply(
    '🗑 *إزالة كاشير*\n\nأرسل *معرف تليجرام* الخاص بالكاشير لإزالته.',
    { parse_mode: 'Markdown' }
  )
})

bot.action('list_cashiers_btn', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()

  const { data: cashiers, error } = await supabase
    .from('staff')
    .select('*')
    .eq('role', 'cashier')
    .eq('is_active', true)

  if (error) return ctx.reply(`❌ ${error.message}`)
  if (!cashiers?.length) return ctx.reply('📭 لا يوجد كاشيرات بعد.')

  const lines = cashiers.map(c => `• @${c.telegram_username || '(لا يوجد اسم مستخدم)'} — \`${c.telegram_id}\``).join('\n')
  await ctx.reply(`📋 *الكاشيرات النشطين*\n\n${lines}`, { parse_mode: 'Markdown' })
})

// ─── ADMIN: MANAGE SLOTS ─────────────────────────────────────

bot.hears('🕐 إدارة الأوقات', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ غير مصرح.')
  await showSlotsManagement(ctx)
})

async function showSlotsManagement(ctx) {
  const { data: slots, error } = await supabase
    .from('pickup_slots')
    .select('*')
    .order('slot_time')

  if (error) return ctx.reply(`❌ ${error.message}`)

  let text = '🕐 *أوقات الاستلام*\n\n'
  if (!slots?.length) {
    text += '(لا توجد أوقات بعد)\n'
  } else {
    text += slots.map(s =>
      `${s.is_active ? '✅' : '❌'} *${s.label}* — الحد الأقصى ${s.max_orders}`
    ).join('\n')
  }

  const buttons = (slots || []).map(s => [
    Markup.button.callback(`⚙️ ${s.label}`, `slotmgr_${s.id}`)
  ])
  buttons.push([Markup.button.callback('➕ إضافة وقت', 'slot_add')])

  await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) })
}

bot.action(/^slotmgr_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  const id = ctx.match[1]
  const { data: slot } = await supabase.from('pickup_slots').select('*').eq('id', id).maybeSingle()
  if (!slot) return ctx.reply('الوقت غير موجود.')

  await ctx.reply(
    `🕐 *${slot.label}*\nالوقت: ${slot.slot_time}\nالحد الأقصى للطلبات: ${slot.max_orders}\nنشط: ${slot.is_active ? 'نعم' : 'لا'}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(slot.is_active ? '🙈 إلغاء التفعيل' : '👁 تفعيل', `slottoggle_${id}`)],
        [Markup.button.callback('✏️ إعادة التسمية', `slotrename_${id}`)],
        [Markup.button.callback('🔢 تعيين الحد الأقصى للطلبات', `slotmax_${id}`)],
        [Markup.button.callback('🗑 حذف', `slotdelete_${id}`)]
      ])
    }
  )
})

bot.action(/^slottoggle_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  const id = ctx.match[1]
  const { data: slot } = await supabase.from('pickup_slots').select('is_active').eq('id', id).maybeSingle()
  if (!slot) return ctx.answerCbQuery('غير موجود.')
  const { error } = await supabase.from('pickup_slots').update({ is_active: !slot.is_active }).eq('id', id)
  if (error) return ctx.answerCbQuery(`خطأ: ${error.message}`)
  await ctx.answerCbQuery('تم التحديث')
  await ctx.reply(slot.is_active ? '🙈 تم إلغاء تفعيل الوقت.' : '👁 تم تفعيل الوقت.')
})

bot.action(/^slotrename_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_slot_rename', slotId: ctx.match[1] })
  await ctx.reply('✏️ أرسل *التسمية* الجديدة لهذا الوقت (مثل "12:00 م").', { parse_mode: 'Markdown' })
})

bot.action(/^slotmax_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_slot_max', slotId: ctx.match[1] })
  await ctx.reply('🔢 أرسل *الحد الأقصى للطلبات* (عدد صحيح موجب).', { parse_mode: 'Markdown' })
})

bot.action(/^slotdelete_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  const id = ctx.match[1]
  const { error } = await supabase.from('pickup_slots').delete().eq('id', id)
  if (error) {
    await ctx.answerCbQuery()
    return ctx.reply(`❌ ${error.message}`)
  }
  await ctx.answerCbQuery('تم الحذف')
  await ctx.reply('🗑 تم حذف الوقت.')
})

bot.action('slot_add', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_new_slot_label' })
  await ctx.reply('➕ أرسل *التسمية* للوقت الجديد (مثل "12:00 م").', { parse_mode: 'Markdown' })
})

// ─── ADMIN: BROADCAST ────────────────────────────────────────

bot.hears('📢 إرسال إعلان', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ غير مصرح.')
  adminFlowState.set(ctx.from.id, { step: 'awaiting_broadcast_message' })
  await ctx.reply(
    '📢 *إرسال إعلان*\n\nأرسل الرسالة التي تريد إرسالها إلى *جميع المستخدمين*.\n\nرد بـ /cancel لإلغاء الأمر.',
    { parse_mode: 'Markdown' }
  )
})

bot.action('broadcast_confirm', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()

  const state = adminFlowState.get(ctx.from.id)
  if (!state || state.step !== 'awaiting_broadcast_confirm') {
    return ctx.reply('⚠️ لا يوجد شيء للإرسال. اضغط 📢 إرسال إعلان مرة أخرى.')
  }

  const message = state.message
  adminFlowState.delete(ctx.from.id)

  const { data: users, error } = await supabase
    .from('users')
    .select('telegram_id')
    .not('telegram_id', 'is', null)

  if (error) return ctx.reply(`❌ ${error.message}`)
  if (!users?.length) return ctx.reply('📭 لا يوجد مستخدمون للإشعار.')

  await ctx.reply(`📡 جاري الإرسال إلى ${users.length} مستخدم(ين)...`)

  let sent = 0
  let failed = 0
  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u.telegram_id, `📢 *إعلان*\n\n${message}`, { parse_mode: 'Markdown' })
      sent++
    } catch (err) {
      failed++
      console.error(`Broadcast fail for ${u.telegram_id}:`, err.message)
    }
  }

  await ctx.reply(`✅ اكتمل الإرسال.\n\n📬 تم الإرسال: ${sent}\n⚠️ فشل: ${failed}`)
})

bot.action('broadcast_cancel', async (ctx) => {
  await ctx.answerCbQuery('تم الإلغاء')
  adminFlowState.delete(ctx.from.id)
  await ctx.reply('❌ تم إلغاء الإعلان.')
})

// ─── ADMIN: ANALYTICS ────────────────────────────────────────

bot.hears('📊 الإحصائيات', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ غير مصرح.')

  await ctx.reply(
    '📊 *الإحصائيات*\n\nاختر الفترة:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('اليوم', 'analytics_1')],
        [Markup.button.callback('آخر 7 أيام', 'analytics_7')],
        [Markup.button.callback('آخر 30 يوم', 'analytics_30')],
        [Markup.button.callback('مخصص (عدد الأيام)', 'analytics_custom')]
      ])
    }
  )
})

bot.action('analytics_custom', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  adminFlowState.set(ctx.from.id, { step: 'awaiting_analytics_days' })
  await ctx.reply('🔢 كم يوماً تريد الرجوع؟ أرسل عدداً صحيحاً موجباً (مثل 14).')
})

bot.action(/^analytics_(\d+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.answerCbQuery('⛔ غير مصرح.')
  await ctx.answerCbQuery()
  const days = parseInt(ctx.match[1], 10)
  await showAnalytics(ctx, days)
})

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
    .map(([name, v], idx) => `${idx + 1}. ${name} — ${v.qty} مباع (${v.revenue.toFixed(2)} د.ع)`)
    .join('\n') || '(لا توجد عناصر مباعة)'

  const avgOrder = completed.length ? revenue / completed.length : 0

  await ctx.reply(
    `📊 *الإحصائيات — آخر ${days} يوم(أيام)*\n` +
    `(${from} → ${todayIso()})\n\n` +
    `📦 الطلبات: *${completed.length}* (ملغى: ${cancelled.length})\n` +
    `💵 الإيرادات: *${revenue.toFixed(2)} د.ع*\n` +
    `🧾 متوسط الطلب: *${avgOrder.toFixed(2)} د.ع*\n` +
    `👥 العملاء الفريدون: *${uniqueUsers}*\n\n` +
    `🏆 *أكثر العناصر مبيعاً*\n${topItems}`,
    { parse_mode: 'Markdown' }
  )
}

// ═══════════════════════════════════════════════════════════
// STUDENT HANDLERS
// ═══════════════════════════════════════════════════════════

// ─── BROWSE MENU ─────────────────────────────────────────────

bot.hears('🍽 تصفح القائمة', async (ctx) => {
  const categories = await getCategories()

  if (!categories.length) {
    return ctx.reply('لا توجد عناصر في القائمة حالياً. تحقق لاحقاً!')
  }

  const buttons = categories.map(c =>
    [Markup.button.callback(`${c.emoji || '🍴'} ${c.name}`, `cat_${c.id}`)]
  )

  return ctx.reply(
    '📋 *قائمتنا*\n\nاختر فئة:',
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
    return ctx.answerCbQuery('لا توجد عناصر في هذه الفئة حالياً.')
  }

  await ctx.answerCbQuery()

  for (const item of items) {
    const text = `*${item.name}*\n${item.description || ''}\n\n💰 ${item.price.toFixed(2)} د.ع`
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ أضف إلى السلة', `add_${item.id}`)],
      ])
    })
  }
})

bot.action(/^add_(.+)$/, async (ctx) => {
  const itemId = ctx.match[1]
  const menuItem = await getMenuItem(itemId)

  if (!menuItem) return ctx.answerCbQuery('العنصر غير موجود.')

  const user = await getOrCreateUser(ctx.from.id)
  await addItemToCart(user.id, menuItem)
  await ctx.answerCbQuery(`✅ تم إضافة ${menuItem.name} إلى السلة!`)
})

// ─── CART ────────────────────────────────────────────────────

bot.hears('🛒 سلة المشتريات', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const cart = await getCart(user.id)

  if (!cart || !cart.order_items?.length) {
    return ctx.reply(
      '🛒 سلتك فارغة.\n\nتصفح القائمة لإضافة عناصر!',
      Markup.keyboard([
        ['🍽 تصفح القائمة', '🛒 سلة المشتريات'],
        ['📦 طلباتي', '❓ المساعدة']
      ]).resize()
    )
  }

  const items = cart.order_items
  const total = items.reduce((s, i) => s + i.item_price * i.quantity, 0)
  const summary = formatOrderSummary(cart, items)

  const removeButtons = items.map(i => [
    Markup.button.callback(`❌ إزالة ${i.item_name}`, `remove_${i.id}`)
  ])

  await ctx.reply(
    `🛒 *سلة المشتريات*\n\n${summary}\n\n*المجموع: ${total.toFixed(2)} د.ع*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...removeButtons,
        [Markup.button.callback('✅ تأكيد الطلب', 'confirm_order')],
        [Markup.button.callback('🗑 إفراغ السلة', 'clear_cart')]
      ])
    }
  )
})

bot.action(/^remove_(.+)$/, async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  await removeItemFromCart(user.id, ctx.match[1])
  await ctx.answerCbQuery('تم إزالة العنصر.')
  await ctx.deleteMessage()
})

bot.action('clear_cart', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  await clearCart(user.id)
  await ctx.answerCbQuery('تم إفراغ السلة.')
  await ctx.editMessageText('🗑 تم إفراغ سلة المشتريات.')
})

// ─── CONFIRM ORDER → PICK SLOT ───────────────────────────────

bot.action('confirm_order', async (ctx) => {
  await ctx.answerCbQuery()
  const slots = await getAvailableSlots()

  if (!slots.length) {
    return ctx.reply('⚠️ لا توجد أوقات استلام متاحة حالياً. يرجى المحاولة لاحقاً.')
  }

  const buttons = slots.map(s => [
    Markup.button.callback(
      `🕐 ${s.label} — ${s.spots_left} ${s.spots_left !== 1 ? 'أماكن' : 'مكان'} متبقي`,
      `slot_${s.id}`
    )
  ])

  await ctx.reply(
    '📅 *اختر وقت الاستلام:*',
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
    return ctx.answerCbQuery('سلتك فارغة.')
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
    `✅ *تم تأكيد الطلب!*\n\n` +
    `🎫 رمز طلبك: *${order.order_code}*\n` +
    `🕐 وقت الاستلام: *${slot?.label || 'غير متوفر'}*\n\n` +
    `أظهر هذا الرمز في الكاونتر عند وصولك.\n` +
    `سوف تتلقى إشعاراً عندما يصبح طلبك جاهزاً!`,
    { parse_mode: 'Markdown' }
  )

  await notifyCashiers(bot, order)
})

// ─── MY ORDERS ───────────────────────────────────────────────

bot.hears('📦 طلباتي', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*, pickup_slots(label), order_items(*)')
    .eq('user_id', user.id)
    .neq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    console.error('Error fetching orders:', error.message)
    return ctx.reply('⚠️ تعذر تحميل طلباتك. يرجى المحاولة مرة أخرى.')
  }

  if (!orders?.length) {
    return ctx.reply('ليس لديك طلبات سابقة بعد.')
  }

  const statusEmoji = {
    confirmed: '✅',
    preparing: '👨‍🍳',
    ready: '🔔',
    picked_up: '✔️',
    cancelled: '❌'
  }

  const text = orders.map(o =>
    `${statusEmoji[o.status] || '•'} *${o.order_code}* — ${o.status.toUpperCase()}\n` +
    `🕐 ${o.pickup_slots?.label || 'غير متوفر'} | 💰 ${o.total_amount?.toFixed(2)} د.ع`
  ).join('\n\n')

  await ctx.reply(`📦 *طلباتك الأخيرة*\n\n${text}`, { parse_mode: 'Markdown' })
})

// ═══════════════════════════════════════════════════════════
// CASHIER HANDLERS
// ═══════════════════════════════════════════════════════════

bot.hears('📋 الطلبات النشطة', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.reply('⛔ غير مصرح.')

  const orders = await getPendingOrders()

  if (!orders.length) {
    return ctx.reply('✅ لا توجد طلبات نشطة حالياً.')
  }

  for (const order of orders) {
    const items = order.order_items.map(i => `• ${i.item_name} x${i.quantity}`).join('\n')
    const text =
      `🎫 *${order.order_code}*\n` +
      `👤 الرمز: ${order.users?.anonymous_token}\n` +
      `🕐 الاستلام: ${order.pickup_slots?.label}\n` +
      `📋 الحالة: ${order.status.toUpperCase()}\n\n` +
      `${items}`

    const buttons = []
    if (order.status === 'confirmed') {
      buttons.push([Markup.button.callback('👨‍🍳 تحديد كقيد التحضير', `status_${order.id}_preparing`)])
    }
    if (order.status === 'preparing') {
      buttons.push([Markup.button.callback('🔔 تحديد كجاهز', `status_${order.id}_ready`)])
    }
    if (order.status === 'ready') {
      buttons.push([Markup.button.callback('✔️ تحديد كتم الاستلام', `status_${order.id}_picked_up`)])
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    })
  }
})

bot.action(/^status_(.+)_(.+)$/, async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.answerCbQuery('غير مصرح.')

  const orderId = ctx.match[1]
  const newStatus = ctx.match[2]

  const order = await updateOrderStatus(orderId, newStatus)
  await ctx.answerCbQuery(`تم تحديد الطلب كـ ${newStatus}`)
  await ctx.editMessageText(
    ctx.callbackQuery.message.text + `\n\n✅ تم التحديث إلى: *${newStatus.toUpperCase()}*`,
    { parse_mode: 'Markdown' }
  )

  await notifyStudent(bot, order, newStatus)
})

bot.hears('🔍 البحث عن طلب', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (!role) return ctx.reply('⛔ غير مصرح.')
  await ctx.reply('أدخل رمز الطلب (مثل ORD-4A2B1):')
})

// ═══════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════

bot.command('status', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)

  const { data: order, error } = await supabase
    .from('orders')
    .select('*, pickup_slots(label)')
    .eq('user_id', user.id)
    .in('status', ['confirmed', 'preparing', 'ready'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('Error fetching active order:', error.message)
    return ctx.reply('⚠️ تعذر تحميل طلبك. يرجى المحاولة مرة أخرى.')
  }

  if (!order) return ctx.reply('ليس لديك طلبات نشطة حالياً.')

  const statusEmoji = {
    confirmed: '✅ مؤكد — في انتظار التحضير',
    preparing: '👨‍🍳 قيد التحضير الآن!',
    ready: '🔔 جاهز — تعال لاستلامه!'
  }

  await ctx.reply(
    `📦 *الطلب ${order.order_code}*\n\n` +
    `${statusEmoji[order.status]}\n` +
    `🕐 وقت الاستلام: ${order.pickup_slots?.label}`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('cancel', async (ctx) => {
  if (adminFlowState.has(ctx.from.id)) {
    adminFlowState.delete(ctx.from.id)
    return ctx.reply('❌ تم الإلغاء.')
  }
  return ctx.reply('لا يوجد شيء لإلغائه.')
})

bot.command('addcashier', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ غير مصرح.')
  adminFlowState.set(ctx.from.id, { step: 'awaiting_cashier_id' })
  await ctx.reply(
    '👤 *إضافة كاشير*\n\n' +
    'الخطوة 1 من 2: يرجى إرسال *معرف تليجرام* الخاص بالكاشير (رقمي).\n\n' +
    '💡 تلميح: اطلب منه مراسلة @userinfobot للحصول على معرفه.',
    { parse_mode: 'Markdown' }
  )
})

bot.command('removecashier', async (ctx) => {
  const role = await getStaffRole(ctx.from.id)
  if (role !== 'admin') return ctx.reply('⛔ غير مصرح.')
  adminFlowState.set(ctx.from.id, { step: 'awaiting_remove_id' })
  await ctx.reply(
    '🗑 *إزالة كاشير*\n\nأرسل *معرف تليجرام* الخاص بالكاشير لإزالته.',
    { parse_mode: 'Markdown' }
  )
})

bot.command('cart', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id)
  const cart = await getCart(user.id)

  if (!cart || !cart.order_items?.length) {
    return ctx.reply('🛒 سلتك فارغة.\n\nتصفح القائمة لإضافة عناصر!')
  }

  const items = cart.order_items
  const total = items.reduce((s, i) => s + i.item_price * i.quantity, 0)
  const summary = formatOrderSummary(cart, items)

  await ctx.reply(
    `🛒 *سلة المشتريات*\n\n${summary}\n\n*المجموع: ${total.toFixed(2)} د.ع*`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('help', async (ctx) => {
  await ctx.reply(
    `*مساعدة بوت كورنر*\n\n` +
    `🍽 *تصفح القائمة* — شاهد العناصر المتاحة اليوم\n` +
    `🛒 *سلة المشتريات* — عرض وإدارة سلتك\n` +
    `📦 *طلباتي* — تتبع حالة طلبك\n\n` +
    `بعد تقديم طلبك ستتلقى *رمزاً مكوناً من 4 أرقام*. أظهره في الكاونتر في وقت الاستلام الذي اخترته.\n\n` +
    `لديك أسئلة؟ زورنا في كونتينر كورنر في الحرم الجامعي! 🌽`,
    { parse_mode: 'Markdown' }
  )
})

bot.hears('❓ المساعدة', async (ctx) => {
  await ctx.reply(
    `*مساعدة بوت كورنر*\n\n` +
    `🍽 *تصفح القائمة* — شاهد العناصر المتاحة اليوم\n` +
    `🛒 *سلة المشتريات* — عرض وإدارة سلتك\n` +
    `📦 *طلباتي* — تتبع حالة طلبك\n\n` +
    `بعد تقديم طلبك ستتلقى *رمزاً مكوناً من 4 أرقام*. أظهره في الكاونتر في وقت الاستلام الذي اخترته.\n\n` +
    `لديك أسئلة؟ زورنا في كونتينر كورنر في الحرم الجامعي! 🌽`,
    { parse_mode: 'Markdown' }
  )
})

// ═══════════════════════════════════════════════════════════
// TEXT HANDLER — must be registered LAST so bot.hears() work
// ═══════════════════════════════════════════════════════════

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  const userId = ctx.from.id
  const flow = adminFlowState.get(userId)

  // ─── CASHIER FLOWS ──────────────────────────────────────
  if (!flow) {
    // ORD- lookup (staff only)
    if (text.toUpperCase().startsWith('ORD-')) {
      const role = await getStaffRole(userId)
      if (!role) return
      const order = await getOrderByCode(text)
      if (!order) return ctx.reply('❌ الطلب غير موجود.')
      const items = order.order_items.map(i => `• ${i.item_name} x${i.quantity}`).join('\n')
      return ctx.reply(
        `🎫 *${order.order_code}*\n` +
        `🕐 الاستلام: ${order.pickup_slots?.label}\n` +
        `📋 الحالة: ${order.status.toUpperCase()}\n\n` +
        `${items}`,
        { parse_mode: 'Markdown' }
      )
    }
    return
  }

  // ─── STAFF: ADD CASHIER ──────────────────────────────────
  if (flow.step === 'awaiting_cashier_id') {
    if (!/^\d+$/.test(text)) {
      return ctx.reply('❌ معرف غير صالح. يرجى إرسال معرف تليجرام رقمي فقط.')
    }
    adminFlowState.set(userId, { step: 'awaiting_cashier_username', telegramId: text })
    return ctx.reply(
      '✅ تم حفظ معرف تليجرام.\n\nالخطوة 2 من 2: الآن أرسل *اسم المستخدم* الخاص بالكاشير (بدون @).',
      { parse_mode: 'Markdown' }
    )
  }

  if (flow.step === 'awaiting_cashier_username') {
    const { telegramId } = flow
    const username = text.replace(/^@/, '')
    const hash = hashTelegramId(telegramId)

    const { data: existing } = await supabase
      .from('staff')
      .select('*')
      .eq('telegram_hash', hash)
      .maybeSingle()

    const { error } = await supabase.from('staff').upsert({
      telegram_hash: hash,
      telegram_id: String(telegramId),
      telegram_username: username,
      role: 'cashier',
      is_active: true
    }, { onConflict: 'telegram_hash' })

    adminFlowState.delete(userId)

    if (error) {
      console.error('Error adding cashier:', error.message)
      return ctx.reply('❌ فشل في إضافة الكاشير. يرجى المحاولة مرة أخرى.')
    }

    return ctx.reply(existing
      ? `✅ تم تحديث الكاشير @${username} بنجاح!`
      : `✅ تم إضافة الكاشير @${username} بنجاح!`)
  }

  if (flow.step === 'awaiting_remove_id') {
    if (!/^\d+$/.test(text)) {
      adminFlowState.delete(userId)
      return ctx.reply('❌ معرف غير صالح. يرجى إرسال معرف تليجرام رقمي فقط.')
    }
    const hash = hashTelegramId(text)
    const { error } = await supabase.from('staff').update({ is_active: false }).eq('telegram_hash', hash)
    adminFlowState.delete(userId)
    if (error) {
      console.error('Error removing cashier:', error.message)
      return ctx.reply('❌ فشل في إزالة الكاشير.')
    }
    return ctx.reply('✅ تم إزالة الكاشير.')
  }

  // ─── VIEW ORDERS: CUSTOM DATE ───────────────────────────
  if (flow.step === 'awaiting_orders_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return ctx.reply('❌ تنسيق غير صالح. استخدم YYYY-MM-DD.')
    }
    adminFlowState.delete(userId)
    return showOrdersForDay(ctx, text)
  }

  // ─── MENU FLOWS ─────────────────────────────────────────
  if (flow.step === 'awaiting_item_name') {
    const { error } = await supabase.from('menu_items').update({ name: text }).eq('id', flow.itemId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ تم تحديث اسم العنصر.')
  }

  if (flow.step === 'awaiting_item_price') {
    const price = parseFloat(text)
    if (isNaN(price) || price < 0) return ctx.reply('❌ سعر غير صالح. أرسل رقماً.')
    const { error } = await supabase.from('menu_items').update({ price }).eq('id', flow.itemId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ تم تحديث السعر إلى ${price.toFixed(2)} د.ع.`)
  }

  if (flow.step === 'awaiting_category_rename') {
    const { error } = await supabase.from('categories').update({ name: text }).eq('id', flow.categoryId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ تم إعادة تسمية الفئة.')
  }

  if (flow.step === 'awaiting_new_category_name') {
    // split optional leading emoji + name
    const match = text.match(/^(\p{Extended_Pictographic})\s*(.+)$/u)
    const emoji = match ? match[1] : null
    const name = match ? match[2] : text
    const { error } = await supabase.from('categories').insert({ name, emoji, is_active: true, sort_order: 999 })
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ تم إضافة الفئة "${name}".`)
  }

  if (flow.step === 'awaiting_new_item_name') {
    adminFlowState.set(userId, { step: 'awaiting_new_item_price', categoryId: flow.categoryId, name: text })
    return ctx.reply('💲 الآن أرسل *السعر* (أرقام فقط).', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_item_price') {
    const price = parseFloat(text)
    if (isNaN(price) || price < 0) return ctx.reply('❌ سعر غير صالح. أرسل رقماً.')
    adminFlowState.set(userId, { step: 'awaiting_new_item_description', categoryId: flow.categoryId, name: flow.name, price })
    return ctx.reply('📝 الآن أرسل *وصفاً* قصيراً (أو أرسل "-" إذا لا يوجد).', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_item_description') {
    const description = text === '-' ? null : text
    const { error } = await supabase.from('menu_items').insert({
      category_id: flow.categoryId,
      name: flow.name,
      price: flow.price,
      description,
      is_available: true,
      sort_order: 999
    })
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ تم إضافة العنصر "${flow.name}".`)
  }

  // ─── SLOT FLOWS ─────────────────────────────────────────
  if (flow.step === 'awaiting_slot_rename') {
    const { error } = await supabase.from('pickup_slots').update({ label: text }).eq('id', flow.slotId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply('✅ تم إعادة تسمية الوقت.')
  }

  if (flow.step === 'awaiting_slot_max') {
    const n = parseInt(text, 10)
    if (isNaN(n) || n < 1) return ctx.reply('❌ أرسل عدداً صحيحاً موجباً.')
    const { error } = await supabase.from('pickup_slots').update({ max_orders: n }).eq('id', flow.slotId)
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ تم تعيين الحد الأقصى للطلبات إلى ${n}.`)
  }

  if (flow.step === 'awaiting_new_slot_label') {
    adminFlowState.set(userId, { step: 'awaiting_new_slot_time', label: text })
    return ctx.reply('🕐 أرسل *الوقت* لهذا الوقت بتنسيق HH:MM (24 ساعة، مثل "12:00").', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_slot_time') {
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
      return ctx.reply('❌ وقت غير صالح. استخدم HH:MM (مثل 12:00).')
    }
    const slotTime = text.length === 5 ? `${text}:00` : text
    adminFlowState.set(userId, { step: 'awaiting_new_slot_max', label: flow.label, slot_time: slotTime })
    return ctx.reply('🔢 أخيراً، أرسل *الحد الأقصى للطلبات* لهذا الوقت.', { parse_mode: 'Markdown' })
  }

  if (flow.step === 'awaiting_new_slot_max') {
    const n = parseInt(text, 10)
    if (isNaN(n) || n < 1) return ctx.reply('❌ أرسل عدداً صحيحاً موجباً.')
    const { error } = await supabase.from('pickup_slots').insert({
      label: flow.label,
      slot_time: flow.slot_time,
      max_orders: n,
      is_active: true
    })
    adminFlowState.delete(userId)
    if (error) return ctx.reply(`❌ ${error.message}`)
    return ctx.reply(`✅ تم إضافة الوقت "${flow.label}".`)
  }

  // ─── BROADCAST FLOW ─────────────────────────────────────
  if (flow.step === 'awaiting_broadcast_message') {
    adminFlowState.set(userId, { step: 'awaiting_broadcast_confirm', message: text })
    return ctx.reply(
      `📢 *معاينة:*\n\n${text}\n\nإرسال إلى جميع المستخدمين؟`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ إرسال', 'broadcast_confirm')],
          [Markup.button.callback('❌ إلغاء', 'broadcast_cancel')]
        ])
      }
    )
  }

  // ─── ANALYTICS CUSTOM DAYS ──────────────────────────────
  if (flow.step === 'awaiting_analytics_days') {
    const n = parseInt(text, 10)
    if (isNaN(n) || n < 1 || n > 365) return ctx.reply('❌ أرسل رقماً بين 1 و 365.')
    adminFlowState.delete(userId)
    return showAnalytics(ctx, n)
  }
})

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════

async function notifyCashiers(bot, order) {
  try {
    const { data: cashiers, error } = await supabase
      .from('staff')
      .select('telegram_id')
      .eq('role', 'cashier')
      .eq('is_active', true)

    if (error) {
      console.error('Error fetching cashiers:', error.message)
      return
    }

    if (!cashiers?.length) return

    const { data: orderDetails } = await supabase
      .from('orders')
      .select('*, order_items(*), pickup_slots(label)')
      .eq('id', order.id)
      .single()

    const items = orderDetails?.order_items?.map(i => `• ${i.item_name} x${i.quantity}`).join('\n') || ''
    const message =
      `🔔 *طلب جديد!*\n\n` +
      `🎫 *${order.order_code}*\n` +
      `🕐 الاستلام: ${orderDetails?.pickup_slots?.label || 'غير متوفر'}\n` +
      `💰 ${order.total_amount?.toFixed(2)} د.ع\n\n` +
      `${items}`

    for (const cashier of cashiers) {
      if (cashier.telegram_id) {
        await bot.telegram.sendMessage(cashier.telegram_id, message, { parse_mode: 'Markdown' })
          .catch(err => console.error(`Failed to notify cashier ${cashier.telegram_id}:`, err.message))
      }
    }
  } catch (err) {
    console.error('Error in notifyCashiers:', err.message)
  }
}

async function notifyStudent(bot, order, status) {
  try {
    const messages = {
      preparing: '👨‍🍳 طلبك قيد التحضير!',
      ready: `🔔 طلبك *${order.order_code}* جاهز للاستلام! تعال الآن. 🌽`,
      cancelled: `❌ تم إلغاء طلبك *${order.order_code}*. يرجى التواصل معنا.`
    }

    const msg = messages[status]
    if (!msg) return

    const { data: userData, error } = await supabase
      .from('users')
      .select('telegram_id')
      .eq('id', order.user_id)
      .maybeSingle()

    if (error) {
      console.error('Error fetching user for notification:', error.message)
      return
    }

    if (userData?.telegram_id) {
      await bot.telegram.sendMessage(userData.telegram_id, msg, { parse_mode: 'Markdown' })
        .catch(err => console.error(`Failed to notify student ${userData.telegram_id}:`, err.message))
    }
  } catch (err) {
    console.error('Error in notifyStudent:', err.message)
  }
}

// ─── WEBHOOK EXPORT (for Vercel) ─────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const secret = req.headers['x-telegram-bot-api-secret-token']
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    try {
      await bot.handleUpdate(req.body)
      res.status(200).json({ ok: true })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal error' })
    }
  } else {
    res.status(200).json({ status: 'Corner Bot is running 🌽' })
  }
}
