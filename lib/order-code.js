/**
 * Order codes.
 *
 * The web app mints codes in the form `ORD-XXXXX` (its tracking page and
 * dashboard both strip the `ORD-` prefix), so the bot mints the same shape.
 * The old bot format was a random number 1-1000 against a UNIQUE column —
 * that capped the bot at 1000 orders for the lifetime of the database.
 *
 * The alphabet drops I/O/0/1 so a code read out loud or typed by a cashier
 * can't be confused (32^5 = ~33.5M combinations).
 */

import crypto from 'crypto'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 5
export const CODE_PREFIX = 'ORD-'

/** Generate a fresh code, e.g. "ORD-7KQ2M". */
export function generateOrderCode() {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)]
  }
  return `${CODE_PREFIX}${out}`
}

/**
 * Turn whatever a human typed into a canonical code.
 * "ord-7kq2m" / "ORD7KQ2M" / " ord 7kq2m " -> "ORD-7KQ2M"
 * "482" (legacy bot codes) -> "ORD-482"
 */
export function normalizeOrderCode(input) {
  const cleaned = String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '')
  if (!cleaned) return ''
  if (cleaned.startsWith(CODE_PREFIX)) return cleaned
  if (cleaned.startsWith('ORD')) return `${CODE_PREFIX}${cleaned.slice(3)}`
  return `${CODE_PREFIX}${cleaned}`
}

/**
 * Lookup candidates, most-likely first: the raw text (covers legacy numeric
 * codes) and the normalized `ORD-` form.
 */
export function orderCodeCandidates(input) {
  const raw = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '')
  const normalized = normalizeOrderCode(raw)
  const candidates = [raw, normalized].filter(Boolean)
  // If the raw string already carries a prefix but with junk separators,
  // also try the bare body (e.g. "ORD 7KQ2M" -> "7KQ2M").
  const body = normalized.replace(CODE_PREFIX, '')
  if (body && body !== normalized) candidates.push(body)
  return [...new Set(candidates)]
}

/**
 * True if the text could be an order code a cashier would type:
 * ORD-7KQ2M, ORD 7KQ2M, 7KQ2M-style bodies (handled via normalize), legacy
 * numeric codes, or a bare numeric id.
 */
export function looksLikeOrderCode(input) {
  const s = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (/^ORD-?[A-Z0-9]{1,10}$/.test(s)) return true
  if (/^\d{1,6}$/.test(s)) return true
  return false
}
