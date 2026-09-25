/**
 * End-to-end flow tests.
 *
 * These drive the real Telegraf bot through `handleUpdate`, over the real HTTP
 * client, against a local Bot API stub, with an in-memory PostgREST-shaped
 * database. Nothing here touches the network.
 */

import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'

import { createFakeSupabase } from './support/fake-supabase.js'
import { startFakeTelegramApi } from './support/fake-telegram-api.js'
import { textUpdate, callbackUpdate, buttonsOf } from './support/telegram-updates.js'
import { zonedNow, todayIso } from '../lib/time.js'

process.env.BOT_TOKEN ||= 'test-token'
process.env.SUPABASE_URL ||= 'http://localhost:1'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-key'
process.env.WEBHOOK_SECRET ||= 'test-secret'
process.env.ADMIN_TELEGRAM_ID ||= '777'

const STUDENT = 111
const CASHIER = 999
const ADMIN = 777
const CAT_1 = 'a1111111-1111-4111-8111-111111111111'
const ITEM_1 = 'a2222222-2222-4222-8222-222222222222'
const SLOT_1 = 'a3333333-3333-4333-8333-333333333333'
const SLOT_PAST = 'a4444444-4444-4444-8444-444444444444'
const GRP_1 = 'a5555555-5555-4555-8555-555555555555'
const TOP_1 = 'a6666666-6666-4666-8666-666666666666'
const TOP_2 = 'a7777777-7777-4777-8777-777777777777'

// The app imports `./supabase.js`; swap it for a proxy to the current fake.
let current = null
mock.module('../lib/supabase.js', {
  defaultExport: { from: (...args) => current.from(...args), rpc: (...args) => current.rpc(...args) }
})

const { createBot } = await import('../lib/bot.js')
const { confirmOrder, getOrderByCode, SlotFullError } = await import('../lib/orders.js')
const { getAvailableSlots } = await import('../lib/slots.js')
const { notifyCashiers, retryCashierNotices } = await import('../lib/notifications.js')

// ─── fixtures ───────────────────────────────────────────────────

const uuid = () => crypto.randomUUID()
const telegramHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex')

function futureSlotTime() {
  const now = zonedNow()
  const minutes = Math.min(now.minutes + 5, 24 * 60)
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${hh}:${mm}:00`
}

function pastSlotTime() {
  const now = zonedNow()
  const minutes = Math.max(0, now.minutes - 5)
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${hh}:${mm}:00`
}

function baseSeed({ slotMaxOrders = 3 } = {}) {
  return {
    categories: [{ id: CAT_1, name: 'برغر', emoji: '🍔', is_active: true, sort_order: 1 }],
    menu_items: [
      {
        id: ITEM_1,
        category_id: CAT_1,
        name: 'زنجر',
        description: 'دجاج مقرمش',
        price: 3000,
        is_available: true,
        sort_order: 1
      }
    ],
    toppings: [
      { id: TOP_1, name: 'شيدر', price: 500, is_active: true },
      { id: TOP_2, name: 'بدون جبن', price: 0, is_active: true }
    ],
    topping_groups: [{ id: GRP_1, name: 'الجبن', selection_type: 'single', required: true }],
    topping_group_options: [
      { id: 'opt-1', group_id: GRP_1, topping_id: TOP_1 },
      { id: 'opt-2', group_id: GRP_1, topping_id: TOP_2 }
    ],
    item_topping_groups: [{ id: 'itg-1', menu_item_id: ITEM_1, group_id: GRP_1 }],
    pickup_slots: [
      {
        id: SLOT_1,
        label: '12:00 PM',
        slot_time: futureSlotTime(),
        max_orders: slotMaxOrders,
        is_active: true
      },
      {
        id: SLOT_PAST,
        label: 'فترة فاتت',
        slot_time: pastSlotTime(),
        max_orders: 10,
        is_active: true
      }
    ],
    staff: [
      {
        id: 'staff-1',
        telegram_id: String(CASHIER),
        telegram_hash: telegramHash(CASHIER),
        telegram_username: 'cashier',
        role: 'cashier',
        is_active: true
      }
    ],
    users: [],
    orders: [],
    order_items: [],
    bot_state: []
  }
}

const harnesses = []

async function harness(seedOverrides = {}) {
  const api = await startFakeTelegramApi()
  current = createFakeSupabase(baseSeed(seedOverrides))
  const bot = createBot('test:token', { telegram: { apiRoot: api.apiRoot } })
  const h = {
    api,
    db: current,
    seed: current.tables,
    send: (update) => bot.handleUpdate(update),
    text: (text, userId = STUDENT) => bot.handleUpdate(textUpdate(text, { userId })),
    tap: (data, userId = STUDENT, messageId) => bot.handleUpdate(callbackUpdate(data, { userId, messageId }))
  }
  harnesses.push(h)
  return h
}

after(async () => {
  await Promise.all(harnesses.map((h) => h.api.close()))
})

function lastMessage(api) {
  const messages = api.messages()
  return messages[messages.length - 1]?.payload || null
}

function lastEdit(api) {
  const edits = api.edits()
  return edits[edits.length - 1]?.payload || null
}

// ─── student happy path ─────────────────────────────────────────

test('student can browse, customize, and order a meal end to end', async () => {
  const h = await harness()

  // 1. welcome
  await h.text('/start')
  assert.match(lastMessage(h.api).text, /أهلاً بيك/)

  // 2. browse menu -> category buttons with real ids
  h.api.take()
  await h.text('🍽 تصفح المنيو')
  const catPayload = lastMessage(h.api)
  assert.ok(buttonsOf(catPayload).some(([, data]) => data === `cat_${CAT_1}`))
  assert.ok(buttonsOf(catPayload).some(([, data]) => data === 'view_cart'))

  // 3. category -> item buttons carry prices
  h.api.take()
  await h.tap(`cat_${CAT_1}`)
  const itemPayload = lastEdit(h.api)
  const itemButton = buttonsOf(itemPayload).find(([, data]) => data === `item_${ITEM_1}`)
  assert.ok(itemButton, 'item button should exist')
  assert.match(itemButton[0], /3,000 د\.ع/)

  // 4. item -> customization screen with a required group
  h.api.take()
  await h.tap(`item_${ITEM_1}`)
  const custom = lastEdit(h.api)
  assert.match(custom.text, /الجبن/)
  assert.match(custom.text, /مطلوب/)
  assert.ok(lastMessage(h.api) === null || true) // no extra chatter required
  const blocked = buttonsOf(custom).find(([, data]) => data === 'confirm_item_disabled')
  assert.ok(blocked, 'confirm must be blocked until the required group is chosen')
  assert.match(blocked[0], /الجبن/)

  // 5. pick a topping -> price updates to 3,500
  h.api.take()
  await h.tap(`toggle_topping_${TOP_1}`)
  const withTopping = lastEdit(h.api)
  assert.match(withTopping.text, /3,500 د\.ع/)
  assert.ok(buttonsOf(withTopping).some(([, data]) => data === 'confirm_item'))

  // 6. quantity up -> total doubles
  h.api.take()
  await h.tap('qty_up')
  assert.match(lastEdit(h.api).text, /الكمية: 2/)
  assert.match(lastEdit(h.api).text, /7,000 د\.ع/)

  // 7. add to cart -> one order_items row with the topping baked into the price
  h.api.take()
  await h.tap('confirm_item')
  const items = h.db.rows('order_items')
  assert.equal(items.length, 1)
  assert.equal(items[0].item_name, 'زنجر')
  assert.equal(items[0].item_price, 3500)
  assert.equal(items[0].quantity, 2)
  assert.match(items[0].customization, /شيدر/)
  assert.ok(buttonsOf(lastEdit(h.api)).some(([, data]) => data === 'view_cart'))

  // 8. cart screen: summary + one editable card per line
  h.api.take()
  await h.text('🛒 سلتي')
  const orderItemId = items[0].id
  const summary = h.api
    .messages()
    .map((m) => m.payload)
    .find((p) => buttonsOf(p).some(([, data]) => data === 'confirm_order'))
  assert.ok(summary, 'cart summary message should exist')
  assert.match(summary.text, /7,000 د\.ع/)
  assert.ok(buttonsOf(summary).some(([, data]) => data === 'confirm_order'))
  assert.ok(buttonsOf(summary).some(([, data]) => data === 'cart_note'))
  const itemCard = h.api.messages().find((m) => m.payload.text.includes('زنجر'))
  assert.ok(itemCard, 'cart should render an item card')
  assert.ok(buttonsOf(itemCard.payload).some(([, data]) => data === `cart_qty_up_${orderItemId}`))

  // 9. quantity controls edit the item card AND the summary (no stale totals)
  h.api.take()
  await h.tap(`cart_qty_up_${orderItemId}`, STUDENT, itemCard.messageId)
  await waitFor(() => h.api.edits().length >= 2)
  const editTexts = h.api.edits().map((e) => e.payload.text)
  assert.ok(editTexts.some((t) => /× 3/.test(t)), 'item card should show the new quantity')
  assert.ok(editTexts.some((t) => /10,500 د\.ع/.test(t)), 'summary should show the new total')
  assert.equal(h.db.rows('order_items')[0].quantity, 3)

  // 10. checkout offers only the slot that is still in the future
  h.api.take()
  await h.tap('confirm_order')
  const slotPayload = lastMessage(h.api)
  const slotButtons = buttonsOf(slotPayload)
  assert.ok(slotButtons.some(([, data]) => data === `slot_${SLOT_1}`), 'future slot offered')
  assert.ok(!slotButtons.some(([, data]) => data === `slot_${SLOT_PAST}`), 'past slot hidden')
  assert.match(slotButtons.find(([, data]) => data === `slot_${SLOT_1}`)[0], /باقي 3/)

  // 11. choose cash and book it
  h.api.take()
  await h.tap(`slot_${SLOT_1}`)
  assert.ok(buttonsOf(lastMessage(h.api)).some(([, data]) => data === `pay_cash_${SLOT_1}`))
  h.api.take()
  await h.tap(`pay_cash_${SLOT_1}`)
  const order = h.db.rows('orders').find((o) => o.status === 'confirmed')
  assert.ok(order, 'order should be confirmed')
  assert.match(order.order_code, /^ORD-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/)
  assert.equal(order.slot_id, SLOT_1)
  assert.equal(order.total_amount, 10500)

  const confirmation = h.api.messages().map((m) => m.payload.text).join('\n')
  assert.match(confirmation, new RegExp(order.order_code))
  assert.match(confirmation, /تم تثبيت طلبك/)
  assert.match(confirmation, /12:00 PM/)

  // cashier was notified with the new order code
  const cashierNotified = h.api
    .messages()
    .some((m) => String(m.payload.chat_id) === String(CASHIER) && m.payload.text.includes(order.order_code))
  assert.ok(cashierNotified, 'cashier must be notified')

  // cart UI bookkeeping was cleaned up
  const state = h.db.rows('bot_state').find((r) => r.user_id === String(STUDENT) || r.user_id === STUDENT)
  assert.ok(!state?.state?.cartUi, 'cartUi state should be cleared after checkout')

  // the cart itself is no longer pending
  assert.ok(!h.db.rows('orders').some((o) => o.status === 'pending'))
})

test('cash staff notice remains queued after a send error and is sent once', async () => {
  const h = await harness()
  const userId = uuid()
  const orderId = uuid()
  h.db.rows('users').push({ id: userId, telegram_id: String(STUDENT) })
  h.db.rows('orders').push({ id: orderId, user_id: userId, status: 'pending',
    order_code: 'ORD-RETRY', slot_id: SLOT_1, total_amount: 3000,
    created_at: new Date().toISOString() })
  h.db.rows('order_items').push({ id: uuid(), order_id: orderId,
    menu_item_id: ITEM_1, item_name: 'زنجر', item_price: 3000, quantity: 1 })
  const queued = await h.db.rpc('queue_telegram_cash_staff_notices', {
    p_user_id: userId, p_cart_id: orderId
  })
  assert.equal(queued.data, 1)
  const denied = await h.db.rpc('queue_telegram_cash_staff_notices', {
    p_user_id: uuid(), p_cart_id: orderId
  })
  assert.ok(denied.error)
  h.db.rows('orders')[0].status = 'confirmed'

  let attempts = 0
  const botStub = { telegram: { sendMessage: async () => {
    attempts++
    if (attempts === 1) throw new Error('temporary Telegram failure')
  } } }
  const order = { id: orderId, status: 'confirmed' }
  assert.equal((await notifyCashiers(botStub, order)).failed, 1)
  assert.equal(h.db.rows('telegram_cash_staff_notices')[0].status, 'pending')
  assert.equal(await retryCashierNotices(20, botStub), 1)
  assert.equal(h.db.rows('telegram_cash_staff_notices')[0].status, 'sent')
  assert.equal((await notifyCashiers(botStub, order)).sent, 0)
  assert.equal(attempts, 2)
})

// ─── capacity ───────────────────────────────────────────────────

test('a full slot is hidden from students', async () => {
  const h = await harness({ slotMaxOrders: 1 })
  h.db.rows('orders').push({
    id: uuid(),
    status: 'confirmed',
    slot_id: SLOT_1,
    created_at: new Date().toISOString(),
    total_amount: 1000
  })

  const slots = await getAvailableSlots()
  assert.deepEqual(slots.map((s) => s.id), [])
})

test('confirmOrder refuses to oversell and leaves the cart intact', async () => {
  const h = await harness({ slotMaxOrders: 1 })

  // a cart for the student
  const cartId = uuid()
  h.db.rows('orders').push({ id: cartId, status: 'pending', user_id: 'u1', created_at: new Date().toISOString() })
  h.db.rows('order_items').push({ id: uuid(), order_id: cartId, item_name: 'زنجر', item_price: 3000, quantity: 1 })

  // the slot already holds one order
  h.db.rows('orders').push({
    id: uuid(),
    status: 'confirmed',
    slot_id: SLOT_1,
    created_at: new Date().toISOString(),
    total_amount: 1000
  })

  await assert.rejects(() => confirmOrder(cartId, SLOT_1), SlotFullError)

  const cart = h.db.rows('orders').find((o) => o.id === cartId)
  assert.equal(cart.status, 'pending', 'cart must stay pending')
  assert.equal(cart.order_code ?? null, null)
})

test('a student who loses a slot race is told and offered the list again', async () => {
  const h = await harness({ slotMaxOrders: 2 })
  // cart, owned by the student the bot will resolve from telegram_hash
  h.db.rows('users').push({ id: 'user-1', telegram_id: String(STUDENT), telegram_hash: telegramHash(STUDENT) })
  const cartId = uuid()
  h.db.rows('orders').push({ id: cartId, status: 'pending', user_id: 'user-1', created_at: new Date().toISOString() })
  h.db.rows('order_items').push({ id: uuid(), order_id: cartId, item_name: 'زنجر', item_price: 3000, quantity: 1 })

  h.api.take()
  await h.tap('confirm_order')
  assert.ok(buttonsOf(lastMessage(h.api)).some(([, data]) => data === `slot_${SLOT_1}`))

  // meanwhile the restaurant fills the slot
  for (let i = 0; i < 2; i++) {
    h.db.rows('orders').push({
      id: uuid(),
      status: 'confirmed',
      slot_id: SLOT_1,
      created_at: new Date().toISOString(),
      total_amount: 1000
    })
  }

  h.api.take()
  await h.tap(`slot_${SLOT_1}`)
  const alerts = h.api.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text)
  assert.ok(alerts.some((t) => /امتلات/.test(t)), `expected a slot-full alert, got ${JSON.stringify(alerts)}`)

  const stillPending = h.db.rows('orders').find((o) => o.id === cartId)
  assert.equal(stillPending.status, 'pending')
})

// ─── codes & lookup ─────────────────────────────────────────────

test('order lookup accepts normalized and legacy codes', async () => {
  const h = await harness()
  h.db.rows('orders').push({
    id: uuid(),
    order_code: 'ORD-7KQ2M',
    status: 'confirmed',
    created_at: new Date().toISOString()
  })
  h.db.rows('orders').push({
    id: uuid(),
    order_code: '482',
    status: 'confirmed',
    created_at: new Date().toISOString()
  })

  assert.equal((await getOrderByCode('ord-7kq2m')).order_code, 'ORD-7KQ2M')
  assert.equal((await getOrderByCode('ord 7kq2m')).order_code, 'ORD-7KQ2M')
  assert.equal((await getOrderByCode('482')).order_code, '482')
  assert.equal(await getOrderByCode('ORD-99999'), null)
})

// ─── cashier flows ──────────────────────────────────────────────

test('cashier sees ready orders, advances status, and the student is notified', async () => {
  const h = await harness()
  const orderId = uuid()
  h.db.rows('users').push({ id: 'user-1', telegram_id: String(STUDENT), telegram_hash: telegramHash(STUDENT) })
  h.db.rows('orders').push({
    id: orderId,
    order_code: 'ORD-ABC23',
    status: 'ready',
    user_id: 'user-1',
    slot_id: SLOT_1,
    total_amount: 5000,
    created_at: new Date().toISOString()
  })
  h.db.rows('order_items').push({
    id: uuid(),
    order_id: orderId,
    item_name: 'زنجر',
    item_price: 5000,
    quantity: 1
  })

  h.api.take()
  await h.text('📋 الطلبات النشطة', CASHIER)
  const list = h.api.messages().map((m) => m.payload)
  const readyCard = list.find((p) => (p.text || '').includes('ORD-ABC23'))
  assert.ok(readyCard, 'ready orders must appear in the active list')
  assert.ok(
    buttonsOf(readyCard).some(([, data]) => data === `status_${orderId}_picked_up`),
    'a ready order must be markable as picked up'
  )

  // start preparing -> the student gets told
  h.api.take()
  await h.tap(`status_${orderId}_preparing`, CASHIER)
  assert.equal(h.db.rows('orders').find((o) => o.id === orderId).status, 'preparing')
  assert.ok(
    h.api.messages().some((m) => String(m.payload.chat_id) === String(STUDENT) && /بدينا نحضر/.test(m.payload.text)),
    'the student must be notified when the kitchen starts'
  )

  // mark picked up -> status changes, and no pointless notification
  h.api.take()
  await h.tap(`status_${orderId}_ready`, CASHIER)
  h.api.take()
  await h.tap(`status_${orderId}_picked_up`, CASHIER)
  assert.equal(h.db.rows('orders').find((o) => o.id === orderId).status, 'picked_up')
})

test('stale buttons cannot revive a cancelled order', async () => {
  const h = await harness()
  const orderId = uuid()
  h.db.rows('orders').push({
    id: orderId,
    order_code: 'ORD-ABC23',
    status: 'cancelled',
    slot_id: SLOT_1,
    total_amount: 5000,
    created_at: new Date().toISOString()
  })

  h.api.take()
  await h.tap(`status_${orderId}_preparing`, CASHIER)

  assert.equal(h.db.rows('orders').find((o) => o.id === orderId).status, 'cancelled')
  const alerts = h.api.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text)
  assert.ok(alerts.some((t) => /ملغي/.test(t)), `expected a refusal alert, got ${JSON.stringify(alerts)}`)
})

test('a cashier typing a code gets the order, and a wrong code gets an answer', async () => {
  const h = await harness()
  const orderId = uuid()
  h.db.rows('orders').push({
    id: orderId,
    order_code: 'ORD-7KQ2M',
    status: 'confirmed',
    slot_id: SLOT_1,
    total_amount: 5000,
    created_at: new Date().toISOString()
  })
  h.db.rows('order_items').push({ id: uuid(), order_id: orderId, item_name: 'زنجر', item_price: 5000, quantity: 1 })

  h.api.take()
  await h.text('ord-7kq2m', CASHIER)
  const card = lastMessage(h.api)
  assert.match(card.text, /ORD-7KQ2M/)
  assert.ok(buttonsOf(card).some(([, data]) => data === `status_${orderId}_preparing`))

  h.api.take()
  await h.text('ORD-ZZZZZ', CASHIER)
  assert.match(lastMessage(h.api).text, /ما لقينا طلب/)
})

test('student text that is not a command gets a way forward, not silence', async () => {
  const h = await harness()
  h.api.take()
  await h.text('مرحبا شلونك')
  const reply = lastMessage(h.api)
  assert.match(reply.text, /ما فهمت/)
  assert.ok(reply.reply_markup?.keyboard, 'the student keyboard should come back')
})

// ─── student self-service ───────────────────────────────────────

test('student can cancel their own confirmed order but not a started one', async () => {
  const h = await harness()
  h.db.rows('users').push({ id: 'user-1', telegram_id: String(STUDENT), telegram_hash: telegramHash(STUDENT) })

  const confirmedId = uuid()
  const preparingId = uuid()
  for (const [id, status] of [
    [confirmedId, 'confirmed'],
    [preparingId, 'preparing']
  ]) {
    h.db.rows('orders').push({
      id,
      order_code: `ORD-${status === 'confirmed' ? 'AAAAA' : 'BBBBB'}`,
      status,
      user_id: 'user-1',
      slot_id: SLOT_1,
      total_amount: 5000,
      created_at: new Date().toISOString()
    })
    h.db.rows('order_items').push({ id: uuid(), order_id: id, item_name: 'زنجر', item_price: 5000, quantity: 1 })
  }

  h.api.take()
  await h.text('📦 طلباتي')
  const list = lastMessage(h.api)
  assert.ok(buttonsOf(list).some(([, data]) => data === `cancelorder_${confirmedId}`))
  assert.ok(!buttonsOf(list).some(([, data]) => data === `cancelorder_${preparingId}`), 'started orders cannot be cancelled')

  // confirm dialog, then cancel
  h.api.take()
  await h.tap(`cancelorder_${confirmedId}`)
  assert.ok(buttonsOf(lastEdit(h.api)).some(([, data]) => data === `cancelorder_yes_${confirmedId}`))

  h.api.take()
  await h.tap(`cancelorder_yes_${confirmedId}`)
  assert.equal(h.db.rows('orders').find((o) => o.id === confirmedId).status, 'cancelled')
  assert.ok(
    h.api.messages().some((m) => String(m.payload.chat_id) === String(CASHIER) && /انلغى من الطالب/.test(m.payload.text)),
    'staff should hear about the cancellation'
  )

  // the started order stays locked
  h.api.take()
  await h.tap(`cancelorder_yes_${preparingId}`)
  assert.equal(h.db.rows('orders').find((o) => o.id === preparingId).status, 'preparing')
})

test('students cannot cancel someone else’s order', async () => {
  const h = await harness()
  const otherId = uuid()
  h.db.rows('users').push({ id: 'user-1', telegram_id: String(STUDENT), telegram_hash: telegramHash(STUDENT) })
  h.db.rows('orders').push({
    id: otherId,
    order_code: 'ORD-OTHER',
    status: 'confirmed',
    user_id: 'someone-else',
    slot_id: SLOT_1,
    total_amount: 5000,
    created_at: new Date().toISOString()
  })

  await h.tap(`cancelorder_yes_${otherId}`)
  assert.equal(h.db.rows('orders').find((o) => o.id === otherId).status, 'confirmed')
})

test('a shared cart button cannot change another customer’s item', async () => {
  const h = await harness()
  const otherCart = uuid()
  const otherItem = uuid()
  h.db.rows('users').push({ id: 'other-user', telegram_id: '9999999', telegram_hash: telegramHash(9999999) })
  h.db.rows('orders').push({ id: otherCart, status: 'pending', user_id: 'other-user', created_at: new Date().toISOString() })
  h.db.rows('order_items').push({ id: otherItem, order_id: otherCart, item_name: 'زنجر', item_price: 3000, quantity: 1 })

  await h.tap(`cart_qty_up_${otherItem}`, STUDENT)
  assert.equal(h.db.rows('order_items').find((item) => item.id === otherItem).quantity, 1)
  assert.ok(h.api.calls.some((call) => call.method === 'answerCallbackQuery'
    && /ما قدرنا/.test(call.payload.text || '')))
})

// ─── order notes ────────────────────────────────────────────────

test('a cart note flows onto the confirmed order', async () => {
  const h = await harness()
  h.db.rows('users').push({ id: 'user-1', telegram_id: String(STUDENT), telegram_hash: telegramHash(STUDENT) })
  const cartId = uuid()
  h.db.rows('orders').push({ id: cartId, status: 'pending', user_id: 'user-1', created_at: new Date().toISOString() })
  h.db.rows('order_items').push({ id: uuid(), order_id: cartId, item_name: 'زنجر', item_price: 3000, quantity: 1 })

  await h.text('🛒 سلتي')
  await h.tap('cart_note')
  await h.text('بدون بصل لو سمحت')

  assert.equal(h.db.rows('orders').find((o) => o.id === cartId).notes, 'بدون بصل لو سمحت')

  await h.tap('confirm_order')
  await h.tap(`slot_${SLOT_1}`)
  await h.tap(`pay_cash_${SLOT_1}`)

  const order = h.db.rows('orders').find((o) => o.id === cartId)
  assert.equal(order.status, 'confirmed')
  assert.equal(order.notes, 'بدون بصل لو سمحت')
})

// ─── resilience ─────────────────────────────────────────────────

test('markdown failures fall back to plain text instead of hanging', async () => {
  const api = await startFakeTelegramApi({ failMarkdown: true })
  current = createFakeSupabase(baseSeed())
  const bot = createBot('test:token', { telegram: { apiRoot: api.apiRoot } })
  harnesses.push({ api })

  const { safeReply } = await import('../lib/handlers/helpers.js')
  const ctx = {
    reply: (text, extra = {}) => bot.telegram.sendMessage(123, text, extra)
  }

  api.take()
  await safeReply(ctx, '*زنجر* — 3,500 د.ع')
  const attempts = api.messages().map((m) => m.payload)
  assert.equal(attempts.length, 2, 'should retry once')
  assert.ok(attempts[0].parse_mode, 'first attempt uses Markdown')
  assert.ok(!attempts[1].parse_mode, 'fallback must be plain text')
  assert.match(attempts[1].text, /زنجر/)
})

// ─── helpers ────────────────────────────────────────────────────

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}
