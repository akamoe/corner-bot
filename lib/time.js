/**
 * Restaurant-local time helpers.
 *
 * Vercel runs in UTC; the restaurant is in Baghdad (UTC+3). Using
 * `new Date().toISOString().split('T')[0]` meant that between 21:00 and
 * midnight UTC (00:00-03:00 Baghdad) the bot counted *yesterday's* orders for
 * slot capacity. Everything date/slot related goes through here instead.
 */

export const TIMEZONE = process.env.RESTAURANT_TIMEZONE || 'Asia/Baghdad'

function partsOf(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute'))
  }
}

/** "YYYY-MM-DD" in restaurant time, plus minutes since local midnight. */
export function zonedNow(date = new Date()) {
  const p = partsOf(date)
  return {
    dateIso: `${p.year}-${p.month}-${p.day}`,
    minutes: p.hour * 60 + p.minute
  }
}

/** Today's date in restaurant time as "YYYY-MM-DD". */
export function todayIso(date = new Date()) {
  return zonedNow(date).dateIso
}

/** Offset string like "+03:00" for the restaurant timezone. */
export function zoneOffset(date = new Date()) {
  const { dateIso, minutes } = zonedNow(date)
  const localAsUtc = Date.parse(`${dateIso}T00:00:00Z`) + minutes * 60_000
  const offsetMinutes = Math.round((localAsUtc - date.getTime()) / 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

/**
 * Inclusive ISO range covering a local calendar day, for filtering a
 * `timestamptz` column (orders.created_at) in PostgREST.
 */
export function dayRange(dateIso = todayIso(), date = new Date()) {
  const off = zoneOffset(date)
  return {
    start: `${dateIso}T00:00:00${off}`,
    end: `${dateIso}T23:59:59.999${off}`
  }
}

/** "12:00:00" / "12:00" -> minutes since midnight (null if unparsable). */
export function slotMinutes(slotTime) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(slotTime ?? ''))
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** True when a daily recurring slot time has already passed today. */
export function isSlotTimePast(slotTime, date = new Date()) {
  const mins = slotMinutes(slotTime)
  if (mins === null) return false
  return mins <= zonedNow(date).minutes
}

/** "2026-05-08" -> "8/5" for compact admin listings. */
export function shortDate(dateIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso ?? ''))
  if (!m) return String(dateIso ?? '')
  return `${Number(m[3])}/${Number(m[2])}`
}

/** ISO day string for "n days before date". */
export function daysAgoIso(n, date = new Date()) {
  const d = new Date(date.getTime() - n * 86_400_000)
  return todayIso(d)
}
