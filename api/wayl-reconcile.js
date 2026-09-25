import { timingSafeEqual } from 'node:crypto'
import { reconcileExpiredPayments } from '../lib/wayl.js'

export async function GET(request) {
  const secret = process.env.CRON_SECRET
  const provided = request.headers.get('authorization') || ''
  const expected = `Bearer ${secret}`
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  if (!secret || left.length !== right.length || !timingSafeEqual(left, right))
    return new Response('Unauthorized', { status: 401 })
  try {
    const handled = await reconcileExpiredPayments()
    return Response.json({ handled })
  } catch {
    return new Response('Unavailable', { status: 503 })
  }
}
