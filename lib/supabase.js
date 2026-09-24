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
let warnedAboutAnonKey = false

export function getSupabaseUrl() {
  return process.env.SUPABASE_URL?.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '') || null
}

function getClient() {
  if (client) return client

  const url = getSupabaseUrl()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.SUPABASE_ANON_KEY
  const key = serviceKey || anonKey

  if (!url || !key) {
    throw new Error(
      'Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
        '(see .env.example). Run `npm run doctor` to check.'
    )
  }

  if (!serviceKey && anonKey && !warnedAboutAnonKey) {
    warnedAboutAnonKey = true
    console.warn(
      '[supabase] SUPABASE_SERVICE_ROLE_KEY is missing — falling back to the anon key, ' +
        'which is subject to RLS and will silently fail reads/writes for the bot.'
    )
  }

  client = createClient(url, key, {
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
