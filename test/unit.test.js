/**
 * Pure-logic tests: money formatting, order codes, Baghdad time, and the
 * presentation helpers (including Telegram's 64-byte callback_data limit).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatIQD, formatNumber, round2 } from '../lib/money.js'
import {
  generateOrderCode,
  normalizeOrderCode,
  orderCodeCandidates,
  looksLikeOrderCode
} from '../lib/order-code.js'
import { todayIso, zonedNow, zoneOffset, dayRange, slotMinutes, isSlotTimePast, daysAgoIso } from '../lib/time.js'
import {
  calculateFinalPrice,
  validateRequiredGroups,
  firstMissingGroup,
  formatOrderItems,
  formatItemToppings,
  orderStatusButtons,
  statusLabel,
  studentOrderCard,
  cashierOrderCard,
  stripMarkdown
} from '../lib/handlers/helpers.js'

// ─── money ──────────────────────────────────────────────────────

test('formatIQD renders dinars without float noise', () => {
  assert.equal(formatIQD(3500), '3,500 د.ع')
  assert.equal(formatIQD(3500.5), '3,500.5 د.ع')
  assert.equal(formatIQD('2500'), '2,500 د.ع')
  assert.equal(formatIQD(0), '0 د.ع')
  assert.equal(formatIQD(null), '0 د.ع')
  assert.equal(formatIQD(undefined), '0 د.ع')
  assert.equal(formatIQD('abc'), '0 د.ع')
  assert.equal(formatIQD(0.1 + 0.2), '0.3 د.ع')
})

test('round2 kills floating point drift in totals', () => {
  assert.equal(round2(0.1 + 0.2), 0.3)
  assert.equal(formatNumber(1234.567), '1,234.57')
})

// ─── order codes ────────────────────────────────────────────────

test('generateOrderCode mints ORD- codes from an unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateOrderCode()
    assert.match(code, /^ORD-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/)
  }
})

test('normalizeOrderCode accepts every way a human types a code', () => {
  assert.equal(normalizeOrderCode('ORD-7KQ2M'), 'ORD-7KQ2M')
  assert.equal(normalizeOrderCode('ord-7kq2m'), 'ORD-7KQ2M')
  assert.equal(normalizeOrderCode('ORD7KQ2M'), 'ORD-7KQ2M')
  assert.equal(normalizeOrderCode(' ord 7kq2m '), 'ORD-7KQ2M')
  assert.equal(normalizeOrderCode('ord_7kq2m'), 'ORD-7KQ2M')
  assert.equal(normalizeOrderCode('7kq2m'), 'ORD-7KQ2M')
  // legacy bot codes were bare numbers
  assert.equal(normalizeOrderCode('482'), 'ORD-482')
  assert.equal(normalizeOrderCode(''), '')
  assert.equal(normalizeOrderCode(null), '')
})

test('orderCodeCandidates tries the raw code before the normalized one', () => {
  assert.deepEqual(orderCodeCandidates('482'), ['482', 'ORD-482'])
  assert.deepEqual(orderCodeCandidates('ord-7kq2m'), ['ORD-7KQ2M', '7KQ2M'])
  assert.deepEqual(orderCodeCandidates('ORD 7KQ2M'), ['ORD7KQ2M', 'ORD-7KQ2M', '7KQ2M'])
  assert.deepEqual(orderCodeCandidates(''), [])
})

test('looksLikeOrderCode only claims plausible codes', () => {
  assert.ok(looksLikeOrderCode('ORD-7KQ2M'))
  assert.ok(looksLikeOrderCode('ord 7kq2m'))
  assert.ok(looksLikeOrderCode('123'))
  assert.ok(!looksLikeOrderCode('hello'))
  assert.ok(!looksLikeOrderCode('بدون بصل'))
  assert.ok(!looksLikeOrderCode(''))
})

// ─── restaurant time ────────────────────────────────────────────

test('todayIso uses Baghdad midnight, not UTC', () => {
  // 22:30 UTC = 01:30 next day in Baghdad (UTC+3)
  assert.equal(todayIso(new Date('2026-05-08T22:30:00Z')), '2026-05-09')
  assert.equal(todayIso(new Date('2026-05-08T20:59:00Z')), '2026-05-08')
})

test('zonedNow reports local minutes since midnight', () => {
  assert.deepEqual(zonedNow(new Date('2026-05-08T09:15:00Z')), { dateIso: '2026-05-08', minutes: 12 * 60 + 15 })
})

test('dayRange produces an ISO window with the Baghdad offset', () => {
  const range = dayRange('2026-05-08', new Date('2026-05-08T09:00:00Z'))
  assert.equal(range.start, '2026-05-08T00:00:00+03:00')
  assert.equal(range.end, '2026-05-08T23:59:59.999+03:00')
  assert.equal(zoneOffset(new Date('2026-05-08T09:00:00Z')), '+03:00')
})

test('isSlotTimePast compares against local time', () => {
  const at10amBaghdad = new Date('2026-05-08T07:00:00Z')
  assert.ok(isSlotTimePast('09:00:00', at10amBaghdad))
  assert.ok(isSlotTimePast('10:00:00', at10amBaghdad))
  assert.ok(!isSlotTimePast('10:01:00', at10amBaghdad))
  assert.ok(!isSlotTimePast('23:00:00', at10amBaghdad))
  assert.ok(!isSlotTimePast(null, at10amBaghdad))
})

test('slotMinutes parses postgres time strings', () => {
  assert.equal(slotMinutes('12:30:00'), 750)
  assert.equal(slotMinutes('12:30'), 750)
  assert.equal(slotMinutes('9:05'), 545)
  assert.equal(slotMinutes('25:00'), null)
  assert.equal(slotMinutes('nonsense'), null)
})

test('daysAgoIso walks back in local time', () => {
  assert.equal(daysAgoIso(0, new Date('2026-05-08T09:00:00Z')), '2026-05-08')
  assert.equal(daysAgoIso(7, new Date('2026-05-08T09:00:00Z')), '2026-05-01')
})

// ─── pricing & customization ────────────────────────────────────

const groups = [
  {
    id: 'g1',
    name: 'الجبن',
    selection_type: 'single',
    required: true,
    toppings: [
      { id: 't1', name: 'شيدر', price: 500 },
      { id: 't2', name: 'بدون جبن', price: 0 }
    ]
  },
  { id: 'g2', name: 'الإضافات', selection_type: 'multiple', required: false, toppings: [{ id: 't3', name: 'صوص حار', price: 250 }] }
]

test('calculateFinalPrice adds only the selected topping prices', () => {
  assert.equal(calculateFinalPrice(3000, [], groups), 3000)
  assert.equal(calculateFinalPrice(3000, ['t1'], groups), 3500)
  assert.equal(calculateFinalPrice(3000, ['t1', 't3'], groups), 3750)
  assert.equal(calculateFinalPrice('3000', ['t1', 't3', 'nope'], groups), 3750)
  assert.equal(calculateFinalPrice(3000, [], []), 3000)
})

test('validateRequiredGroups enforces required groups only', () => {
  assert.ok(!validateRequiredGroups(groups, []))
  assert.ok(validateRequiredGroups(groups, ['t1']))
  assert.ok(validateRequiredGroups(groups, ['t2'])) // free option still satisfies a required group
  assert.ok(validateRequiredGroups([], []))
})

test('firstMissingGroup names the group to fix', () => {
  assert.equal(firstMissingGroup(groups, [])?.name, 'الجبن')
  assert.equal(firstMissingGroup(groups, ['t2']), null)
})

test('formatOrderItems includes toppings and line totals', () => {
  const text = formatOrderItems([
    {
      item_name: 'زنجر',
      quantity: 2,
      item_price: 3500,
      customization: JSON.stringify({ toppings: [{ id: 't1', name: 'شيدر', price: 500 }] })
    },
    { item_name: 'بطاطا', quantity: 1, item_price: 1500, customization: null }
  ])
  assert.match(text, /زنجر ×2 — 7,000 د\.ع/)
  assert.match(text, /شيدر \(\+500 د\.ع\)/)
  assert.match(text, /بطاطا ×1 — 1,500 د\.ع/)
  assert.equal(formatOrderItems([]), '(ماكو أغراض)')
  assert.equal(formatOrderItems(undefined), '(ماكو أغراض)')
})

test('formatItemToppings survives broken json and empty selections', () => {
  assert.equal(formatItemToppings('{not json'), '')
  assert.equal(formatItemToppings(null), '')
  assert.equal(formatItemToppings(JSON.stringify({ toppings: [] })), '')
  assert.equal(formatItemToppings(JSON.stringify({ toppings: [{ name: 'ذرة', price: 0 }] })), 'ذرة')
})

// ─── statuses & cards ───────────────────────────────────────────

test('status helpers cover every status the schema allows', () => {
  for (const status of ['pending', 'confirmed', 'preparing', 'ready', 'picked_up', 'cancelled']) {
    assert.ok(statusLabel(status))
    assert.notEqual(statusLabel(status), status)
  }
  assert.equal(statusLabel('weird'), 'weird')
})

test('order status buttons follow the lifecycle and fit Telegram limits', () => {
  const id = '3f1b6a2e-0f4a-4a1c-9a9e-9f2b7c1d4e5f'

  const confirmed = orderStatusButtons({ id, status: 'confirmed' }).flat()
  assert.deepEqual(
    confirmed.map((b) => b.callback_data),
    [`status_${id}_preparing`, `status_${id}_cancelled`]
  )

  const preparing = orderStatusButtons({ id, status: 'preparing' }).flat()
  assert.deepEqual(
    preparing.map((b) => b.callback_data),
    [`status_${id}_ready`, `status_${id}_cancelled`]
  )

  const ready = orderStatusButtons({ id, status: 'ready' }).flat()
  assert.deepEqual(
    ready.map((b) => b.callback_data),
    [`status_${id}_picked_up`]
  )

  assert.deepEqual(orderStatusButtons({ id, status: 'picked_up' }), [])
  assert.deepEqual(orderStatusButtons({ id, status: 'cancelled' }), [])

  for (const row of [
    ...orderStatusButtons({ id, status: 'confirmed' }),
    ...orderStatusButtons({ id, status: 'preparing' }),
    ...orderStatusButtons({ id, status: 'ready' })
  ]) {
    for (const button of row) {
      assert.ok(
        Buffer.byteLength(button.callback_data, 'utf8') <= 64,
        `callback_data too long: ${button.callback_data}`
      )
    }
  }
})

test('order cards show code, slot, total and items', () => {
  const order = {
    id: 'o1',
    order_code: 'ORD-7KQ2M',
    status: 'preparing',
    total_amount: 7000,
    notes: 'بدون بصل',
    pickup_slots: { label: '12:00 PM' },
    users: { anonymous_token: 'TOK-1' },
    order_items: [{ item_name: 'زنجر', quantity: 2, item_price: 3500, customization: null }]
  }

  const student = studentOrderCard(order)
  assert.match(student, /ORD-7KQ2M/)
  assert.match(student, /قيد التحضير/)
  assert.match(student, /12:00 PM/)
  assert.match(student, /7,000 د\.ع/)
  assert.match(student, /بدون بصل/)

  const cashier = cashierOrderCard(order)
  assert.match(cashier, /TOK-1/)
  assert.match(cashier, /زنجر ×2/)
})

test('stripMarkdown removes the characters Telegram chokes on', () => {
  assert.equal(stripMarkdown('*bold* _x_ `y` [z]'), 'bold x y z')
})
