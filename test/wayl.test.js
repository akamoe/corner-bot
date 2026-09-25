import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  processWaylWebhook, reconcileWith, safeCheckoutUrl, validateWaylLink,
  waylStatus
} from '../lib/wayl-core.js'

const secret = 'test-only-secret-of-at-least-thirty-two-characters'
const reference = 'corner-bot-12345678-1234-4234-8234-123456789abc'
const body = JSON.stringify({ referenceId: reference, paymentStatus: 'Complete' })

function signedRequest(text = body, signingSecret = secret) {
  return new Request('https://example.test/api/wayl', {
    method: 'POST', body: text,
    headers: { 'x-wayl-signature-256': createHmac('sha256', signingSecret).update(text).digest('hex') }
  })
}

test('forged, wrong-secret, tampered, and oversized callbacks do no work', async () => {
  let calls = 0
  const reconcile = async () => { calls++; return { status: 'pending' } }
  const forged = new Request('https://example.test/api/wayl', { method: 'POST', body })
  assert.equal((await processWaylWebhook(forged, { secret, reconcile })).status, 401)
  assert.equal((await processWaylWebhook(signedRequest(body, 'wrong-secret'), { secret, reconcile })).status, 401)
  const tampered = signedRequest(body.replace('Complete', 'Cancelled'))
  tampered.headers.set('x-wayl-signature-256', createHmac('sha256', secret).update(body).digest('hex'))
  assert.equal((await processWaylWebhook(tampered, { secret, reconcile })).status, 401)
  assert.equal((await processWaylWebhook(signedRequest('x'.repeat(65 * 1024)), { secret, reconcile })).status, 413)
  assert.equal((await processWaylWebhook(signedRequest(), { secret: null, reconcile })).status, 503)
  assert.equal(calls, 0)
})

test('a signed unknown reference is ignored and cannot access an order', async () => {
  const response = await processWaylWebhook(signedRequest(), {
    secret, reconcile: async () => ({ status: 'unknown' })
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ignored, true)
  const malformed = await processWaylWebhook(signedRequest('{"referenceId":"other"}'), {
    secret, reconcile: async () => { throw new Error('must not run') }
  })
  assert.equal(malformed.status, 400)
})

test('amount, currency, and reference must match the local payment', () => {
  const payment = { reference, amount: 3000, currency: 'IQD' }
  const link = { referenceId: reference, total: '3000', currency: 'IQD', status: 'Complete' }
  assert.equal(validateWaylLink(link, payment), link)
  assert.equal(validateWaylLink({ ...link, total: '3000.00' }, payment).total, '3000.00')
  for (const field of ['total', 'currency', 'referenceId']) {
    const bad = { ...link, [field]: field === 'total' ? '2999' : 'bad' }
    assert.throws(() => validateWaylLink(bad, payment), /WAYL_PAYMENT_MISMATCH/)
  }
  assert.equal(safeCheckoutUrl('https://checkout.thewayl.com/pay/abc'),
    'https://checkout.thewayl.com/pay/abc')
  assert.throws(() => safeCheckoutUrl('https://checkout.thewayl.com.evil.test/pay/abc'))
})

test('duplicate and out-of-order callbacks cannot create a second order or reverse paid state', async () => {
  const payment = { reference, amount: 3000, currency: 'IQD', environment: 'live', status: 'pending' }
  let vendorStatus = 'Complete'
  let orders = 0
  let cancelCalls = 0
  const deps = {
    load: async () => payment,
    fetch: async () => ({ referenceId: reference, total: '3000', currency: 'IQD', status: vendorStatus }),
    complete: async () => {
      if (payment.status === 'refunded') return { status: 'refunded' }
      if (payment.status === 'pending') { payment.status = 'paid'; orders++ }
      return { status: 'paid', order_code: 'ORD-TEST2' }
    },
    cancel: async () => { cancelCalls++; payment.status = 'cancelled'; return { status: 'cancelled' } },
    refund: async () => { payment.status = 'refunded'; return { status: 'refunded' } },
    notify: async () => {}
  }
  assert.equal((await reconcileWith(reference, deps)).status, 'paid')
  assert.equal((await reconcileWith(reference, deps)).status, 'paid')
  assert.equal(orders, 1)
  vendorStatus = 'Cancelled'
  assert.equal((await reconcileWith(reference, deps)).status, 'paid')
  assert.equal(cancelCalls, 0)
  vendorStatus = 'Returned'
  assert.equal((await reconcileWith(reference, deps)).status, 'refunded')
  vendorStatus = 'Complete'
  assert.equal((await reconcileWith(reference, deps)).status, 'refunded')
  assert.equal(waylStatus('Unknown'), 'unknown')
})
