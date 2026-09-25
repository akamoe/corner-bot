import { createHmac, timingSafeEqual } from 'node:crypto'

export const MAX_WEBHOOK_BYTES = 64 * 1024
export const WAYL_STATUSES = Object.freeze({
  Created: 'open', Pending: 'open', Processing: 'open',
  Complete: 'paid', Delivered: 'paid',
  Cancelled: 'cancelled', Rejected: 'cancelled', Returned: 'refunded'
})

export function waylStatus(value) {
  return WAYL_STATUSES[value] || 'unknown'
}

export function safeCheckoutUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('WAYL_URL_INVALID')
  let url
  try { url = new URL(value) } catch { throw new Error('WAYL_URL_INVALID') }
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.thewayl.com'
    || url.username || url.password || url.port) throw new Error('WAYL_URL_INVALID')
  return url.href
}

export function verifyWaylSignature(raw, signature, secret) {
  if (!(raw instanceof Uint8Array) || typeof secret !== 'string' || !secret
    || typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature)) return false
  const expected = createHmac('sha256', secret).update(raw).digest()
  const received = Buffer.from(signature, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export async function readBoundedBody(request, max = MAX_WEBHOOK_BYTES) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    length += value.byteLength
    if (length > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const raw = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength }
  return raw
}

export function validateWaylLink(link, payment) {
  const total = Number(link?.total)
  const expected = Number(payment?.amount)
  if (!link || typeof link !== 'object'
    || link.referenceId !== payment.reference
    || !Number.isSafeInteger(total) || !Number.isSafeInteger(expected)
    || total !== expected
    || link.currency !== 'IQD'
    || payment.currency !== 'IQD') throw new Error('WAYL_PAYMENT_MISMATCH')
  return link
}

export function waylReference(value) {
  return typeof value === 'string' && /^corner-bot-[0-9a-f-]{36}$/.test(value)
}

/** Recheck Wayl's current link before moving local payment state. */
export async function reconcileWith(reference, deps) {
  const payment = await deps.load(reference)
  if (!payment) return { status: 'unknown' }
  const link = validateWaylLink(await deps.fetch(reference), payment)
  const state = waylStatus(link.status)
  if (state === 'paid') {
    const result = await deps.complete(reference)
    if (result.status === 'paid') await deps.notify(payment)
    return { status: result.status, environment: payment.environment,
      orderCode: result.order_code }
  }
  if (state === 'refunded') {
    const result = await deps.refund(reference)
    return { status: result.status, environment: payment.environment }
  }
  if (state === 'cancelled') {
    if (payment.status === 'paid' || payment.status === 'refunded')
      return { status: payment.status, environment: payment.environment }
    const result = await deps.cancel(reference)
    return { status: result.status, environment: payment.environment }
  }
  if (state === 'open') return { status: payment.status, environment: payment.environment,
    url: payment.checkout_url ? safeCheckoutUrl(payment.checkout_url) : undefined }
  return { status: 'unavailable', environment: payment.environment }
}

/** Verify transport and identity before any database or provider work. */
export async function processWaylWebhook(request, { secret, reconcile }) {
  if (!secret) return new Response('Verification unavailable', { status: 503 })
  const raw = await readBoundedBody(request)
  if (raw === null) return new Response('Too large', { status: 413 })
  if (!verifyWaylSignature(raw, request.headers.get('x-wayl-signature-256'), secret))
    return new Response('Unauthorized', { status: 401 })
  let event
  try { event = JSON.parse(new TextDecoder().decode(raw)) }
  catch { return new Response('Bad JSON', { status: 400 }) }
  if (!waylReference(event?.referenceId)) return new Response('Bad reference', { status: 400 })
  try {
    const result = await reconcile(event.referenceId)
    return Response.json({ received: true, ignored: result.status === 'unknown' })
  } catch (error) {
    console.error('[wayl] callback could not be reconciled:', error?.message || 'unknown')
    return new Response('Verification unavailable', { status: 503 })
  }
}
