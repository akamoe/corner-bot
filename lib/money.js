/**
 * Money helpers.
 *
 * Every user-facing price in the bot goes through here so students never see
 * "3500.00 IQD" again — they see "3,500 د.ع".
 */

const IQD = 'د.ع'

/** Format a number as Iraqi Dinar, e.g. 3500 -> "3,500 د.ع" */
export function formatIQD(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return `0 ${IQD}`
  return `${n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })} ${IQD}`
}

/** Thousands separator only, no currency: 3500 -> "3,500" */
export function formatNumber(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })
}

/** Round to 2 decimals to avoid 0.1+0.2 float noise in totals. */
export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}
