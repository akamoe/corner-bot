import supabase from './supabase.js'

async function getState(userId, key) {
  const { data, error } = await supabase
    .from('bot_state')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle()
  
  if (error) console.error('[getState] userId:', userId, 'key:', key, error.message, error)
  
  if (error || !data) return undefined
  return data.state?.[key]
}

/**
 * Set a key in the bot_state for a user.
 *
 * This is a read-modify-write on a single jsonb row, so two concurrent
 * updates for the same user can clobber each other. A real fix needs a
 * `jsonb_set` RPC, which requires DDL; until then we retry once on failure
 * and keep every handler sequential (Telegraf awaits each update).
 */
async function setState(userId, key, value) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: existing, error: readError } = await supabase
      .from('bot_state')
      .select('state')
      .eq('user_id', userId)
      .maybeSingle()

    if (readError) {
      console.error('[setState] read userId:', userId, 'key:', key, readError.message, readError)
      return
    }

    const newState = { ...(existing?.state || {}), [key]: value }

    const { error } = await supabase
      .from('bot_state')
      .upsert({ user_id: userId, state: newState, updated_at: new Date().toISOString() })

    if (!error) return
    console.error('[setState] userId:', userId, 'key:', key, error.message, error)
  }
}

async function deleteState(userId, key) {
  const { data: existing } = await supabase
    .from('bot_state')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle()

  if (!existing?.state) return
  
  const state = existing.state
  delete state[key]

  if (Object.keys(state).length === 0) {
    const { error } = await supabase.from('bot_state').delete().eq('user_id', userId)
    if (error) console.error('[deleteState] delete row userId:', userId, error.message, error)
  } else {
    const { error } = await supabase
      .from('bot_state')
      .upsert({ user_id: userId, state, updated_at: new Date().toISOString() })
    if (error) console.error('[deleteState] upsert userId:', userId, error.message, error)
  }
}

async function hasState(userId, key) {
  const val = await getState(userId, key)
  return val !== undefined
}

export const adminFlowState = {
  get: async (userId) => getState(userId, 'adminFlow'),
  set: async (userId, value) => setState(userId, 'adminFlow', value),
  delete: async (userId) => deleteState(userId, 'adminFlow'),
  has: async (userId) => hasState(userId, 'adminFlow')
}

export const orderFlowState = {
  get: async (userId) => getState(userId, 'orderFlow'),
  set: async (userId, value) => setState(userId, 'orderFlow', value),
  delete: async (userId) => deleteState(userId, 'orderFlow'),
  has: async (userId) => hasState(userId, 'orderFlow')
}

// Tracks the message ids of the cart screen so qty/remove buttons can edit
// them in place instead of spamming the chat.
export const cartUiState = {
  get: async (userId) => getState(userId, 'cartUi'),
  set: async (userId, value) => setState(userId, 'cartUi', value),
  delete: async (userId) => deleteState(userId, 'cartUi')
}

/** Delete bot_state rows that nobody touched for `days` days. */
export async function deleteStaleStates(days = 30) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const { error, count } = await supabase
    .from('bot_state')
    .delete({ count: 'exact' })
    .lt('updated_at', cutoff)

  if (error) {
    console.error('[deleteStaleStates] cutoff:', cutoff, error.message, error)
    return 0
  }
  return count || 0
}
