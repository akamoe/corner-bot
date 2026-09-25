import { randomUUID } from 'node:crypto'
import supabase from './supabase.js'
import { studentOrderCard } from './handlers/helpers.js'
import { safeCheckoutUrl, validateWaylLink, waylStatus, reconcileWith } from './wayl-core.js'

const API = 'https://api.thewayl.com/api/v1/links'

export function waylConfig() {
  const key = process.env.WAYL_API_KEY
  const secret = process.env.WAYL_WEBHOOK_SECRET
  const environment = process.env.WAYL_ENV
  const site = process.env.WAYL_SITE_URL
  if (!key || !secret || secret.length < 32 || !['test', 'live'].includes(environment) || !site) return null
  try {
    const url = new URL(site)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    return { key, secret, environment, origin: url.origin }
  } catch { return null }
}

export class WaylHttpError extends Error {
  constructor(status) { super(`WAYL_HTTP_${status}`); this.status = status }
}

async function requestWayl(path, body, config) {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-WAYL-AUTHENTICATION': config.key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new WaylHttpError(response.status)
  let payload
  try { payload = await response.json() } catch { throw new Error('WAYL_RESPONSE_INVALID') }
  if (!payload?.data || typeof payload.data !== 'object') throw new Error('WAYL_RESPONSE_INVALID')
  return payload.data
}

export function getWaylLink(reference, config = waylConfig()) {
  if (!config) throw new Error('WAYL_NOT_CONFIGURED')
  return requestWayl(`/${encodeURIComponent(reference)}`, undefined, config)
}

export async function invalidateWaylLink(reference, config = waylConfig()) {
  if (!config) throw new Error('WAYL_NOT_CONFIGURED')
  return requestWayl(`/${encodeURIComponent(reference)}/invalidate`, {}, config)
}

async function loadPayment(reference) {
  const { data, error } = await supabase.from('telegram_wayl_payments')
    .select('*').eq('reference', reference).maybeSingle()
  if (error) throw new Error('PAYMENT_READ_FAILED')
  return data
}

async function runPaymentRpc(name, reference) {
  const { data, error } = await supabase.rpc(name, { p_reference: reference })
  if (error) throw new Error(`PAYMENT_SAVE_FAILED:${error.code || 'unknown'}`)
  return data
}

function assertEnvironment(payment, config) {
  if (!config || payment.environment !== config.environment) throw new Error('WAYL_ENV_MISMATCH')
}

export async function createWaylCheckout(userId, cartId, slotId) {
  const config = waylConfig()
  if (!config) throw new Error('WAYL_NOT_CONFIGURED')
  const { data: payment, error } = await supabase.rpc('create_telegram_wayl_checkout', {
    p_user_id: userId, p_cart_id: cartId, p_slot_id: slotId,
    p_request_id: randomUUID(), p_environment: config.environment
  })
  if (error || !payment) throw new Error(`CHECKOUT_RESERVATION_FAILED:${error?.message || 'empty'}`)
  assertEnvironment(payment, config)
  if (payment.status !== 'pending') return { status: payment.status, payment }
  if (Date.parse(payment.expires_at) <= Date.now()) return { status: 'expired', payment }
  if (payment.checkout_url) return { status: 'pending', url: safeCheckoutUrl(payment.checkout_url), payment }

  let link
  try {
    link = await getWaylLink(payment.reference, config)
  } catch (error) {
    if (!(error instanceof WaylHttpError) || error.status !== 404) throw error
    link = await requestWayl('', {
      env: config.environment,
      referenceId: payment.reference,
      total: Number(payment.amount),
      currency: 'IQD',
      lineItem: [{ label: 'Corner order', amount: Number(payment.amount), type: 'increase' }],
      webhookUrl: `${config.origin}/api/wayl`,
      webhookSecret: config.secret,
      redirectionUrl: `${config.origin}/api/wayl-return`,
      linkExpiresIn: '15m'
    }, config)
  }
  validateWaylLink(link, payment)
  const state = waylStatus(link.status)
  if (state !== 'open') return { status: state, payment }
  const url = safeCheckoutUrl(link.url)
  const { error: saveError } = await supabase.from('telegram_wayl_payments')
    .update({ checkout_url: url }).eq('reference', payment.reference).eq('status', 'pending')
  if (saveError) throw new Error('CHECKOUT_URL_SAVE_FAILED')
  return { status: 'pending', url, payment }
}

async function claimNotification(payment, kind) {
  const claimed = `${kind}_notify_claimed_at`
  const notified = `${kind}_notified_at`
  const { data, error } = await supabase.from('telegram_wayl_payments')
    .update({ [claimed]: new Date().toISOString() })
    .eq('reference', payment.reference).eq('status', 'paid')
    .is(claimed, null).is(notified, null).select('*').maybeSingle()
  if (error) throw new Error('NOTIFICATION_CLAIM_FAILED')
  return data
}

async function finishNotification(payment, kind, success) {
  const claimed = `${kind}_notify_claimed_at`
  const notified = `${kind}_notified_at`
  const update = success
    ? { [notified]: new Date().toISOString(), [claimed]: null }
    : { [claimed]: null }
  const { error } = await supabase.from('telegram_wayl_payments')
    .update(update).eq('reference', payment.reference)
  if (error) console.error('[wayl] notification state write failed')
}

async function notifyPaid(payment) {
  const { bot } = await import('./bot.js')
  const { data: user, error: userError } = await supabase.from('users')
    .select('telegram_id').eq('id', payment.user_id).maybeSingle()
  if (userError) throw new Error('PAYMENT_OWNER_READ_FAILED')
  const { data: order, error: orderError } = await supabase.from('orders')
    .select('*, order_items(*), pickup_slots(*)').eq('id', payment.cart_id).maybeSingle()
  if (orderError) throw new Error('PAYMENT_ORDER_READ_FAILED')

  const customerClaim = user?.telegram_id ? await claimNotification(payment, 'customer') : null
  if (customerClaim) {
    try {
      const message = payment.environment === 'test'
        ? '🧪 تأكدنا من الدفع التجريبي. هذا اختبار فقط، وطلبك ما راح ينرسل للمطبخ.'
        : `✅ تأكدنا من الدفع.\n\n${studentOrderCard(order)}\n\nراح نرسلك إشعار لما يجهز 🌽`
      await bot.telegram.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' })
      await finishNotification(payment, 'customer', true)
    } catch {
      await finishNotification(payment, 'customer', false)
      console.error('[wayl] customer notification failed')
    }
  }
}

export async function reconcileWaylPayment(reference) {
  const config = waylConfig()
  if (!config) throw new Error('WAYL_NOT_CONFIGURED')
  return reconcileWith(reference, {
    async load(ref) {
      const payment = await loadPayment(ref)
      if (payment) assertEnvironment(payment, config)
      return payment
    },
    fetch: (ref) => getWaylLink(ref, config),
    complete: (ref) => runPaymentRpc('complete_telegram_wayl_payment', ref),
    refund: (ref) => runPaymentRpc('refund_telegram_wayl_payment', ref),
    cancel: (ref) => runPaymentRpc('cancel_telegram_wayl_payment', ref),
    notify: notifyPaid
  })
}

export async function paymentForCart(cartId) {
  const { data, error } = await supabase.from('telegram_wayl_payments')
    .select('*, pickup_slots(label)').eq('cart_id', cartId).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error('PAYMENT_READ_FAILED')
  return data
}

export async function latestPaymentForUser(userId) {
  const { data, error } = await supabase.from('telegram_wayl_payments')
    .select('*, pickup_slots(label)').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error('PAYMENT_READ_FAILED')
  return data
}

/** Release expired reservations only after Wayl confirms they cannot be paid. */
export async function reconcileExpiredPayments(limit = 20) {
  const config = waylConfig()
  if (!config) return 0
  const { data, error } = await supabase.from('telegram_wayl_payments')
    .select('reference, amount, currency, environment, status')
    .eq('status', 'pending').eq('environment', config.environment)
    .lt('expires_at', new Date().toISOString())
    .order('expires_at').limit(limit)
  if (error) throw new Error('PAYMENT_EXPIRY_READ_FAILED')
  let handled = 0
  for (const payment of data || []) {
    try {
      let link
      try { link = await getWaylLink(payment.reference, config) }
      catch (err) {
        if (err instanceof WaylHttpError && err.status === 404) {
          await runPaymentRpc('cancel_telegram_wayl_payment', payment.reference)
          handled++
          continue
        }
        throw err
      }
      validateWaylLink(link, payment)
      if (waylStatus(link.status) === 'open') {
        link = validateWaylLink(await invalidateWaylLink(payment.reference, config), payment)
      }
      if (waylStatus(link.status) !== 'open') {
        await reconcileWaylPayment(payment.reference)
        handled++
      }
    } catch (err) {
      console.error('[wayl] expired payment reconciliation failed:', err?.message || 'unknown')
    }
  }
  const stale = new Date(Date.now() - 5 * 60_000).toISOString()
  // The bot notifies the customer only, so customer state is the only retry gate.
  const { error: releaseError } = await supabase.from('telegram_wayl_payments')
    .update({ customer_notify_claimed_at: null }).eq('status', 'paid')
    .eq('environment', config.environment)
    .is('customer_notified_at', null).lt('customer_notify_claimed_at', stale)
  if (releaseError) throw new Error('NOTIFICATION_RETRY_RESET_FAILED')
  const { data: unnotified, error: retryError } = await supabase.from('telegram_wayl_payments')
    .select('*').eq('status', 'paid').eq('environment', config.environment)
    .is('customer_notified_at', null)
    .order('paid_at').limit(limit)
  if (retryError) throw new Error('NOTIFICATION_RETRY_READ_FAILED')
  for (const payment of unnotified || []) {
    try { await notifyPaid(payment); handled++ }
    catch (err) { console.error('[wayl] notification retry failed:', err?.message || 'unknown') }
  }
  return handled
}
