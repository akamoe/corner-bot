/**
 * Supabase client (service role — the bot is a backend, RLS does not apply).
 *
 * The client is created lazily so that importing a module which only *may*
 * touch the database (helpers, tests, `npm run check`) doesn't explode when
 * env vars are absent. Missing config now fails on first real query with a
 * message that says what to do.
 */

import { createClient } from '@supabase/supabase-js'

let client = null

export function getSupabaseUrl() {
  return process.env.SUPABASE_URL?.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '') || null
}

function getClient() {
  if (client) return client

  const url = getSupabaseUrl()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error(
      'Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
        '(see .env.example). Run `npm run doctor` to check.'
    )
  }

  client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  return client
}

const supabase = new Proxy(
  {},
  {
    get(_target, prop) {
      const real = getClient()
      const value = real[prop]
      return typeof value === 'function' ? value.bind(real) : value
    }
  }
)

export default supabase
