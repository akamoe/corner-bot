import { processWaylWebhook } from '../lib/wayl-core.js'
import { reconcileWaylPayment, waylConfig } from '../lib/wayl.js'

export async function POST(request) {
  const config = waylConfig()
  return processWaylWebhook(request, {
    secret: config?.secret,
    reconcile: reconcileWaylPayment
  })
}
