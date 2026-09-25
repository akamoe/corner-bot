import supabase from './supabase.js'

async function getState(userId, key) {
  const { data, error } = await supabase
    .from('bot_state')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle()
  
  if (error) throw error
  if (!data) return undefined
  return data.state?.[key]
}

/** Change one JSON key with an updated_at compare-and-swap. */
async function patchState(userId, key, value, remove = false) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: existing, error: readError } = await supabase
      .from('bot_state')
      .select('state, updated_at')
      .eq('user_id', userId)
      .maybeSingle()
    if (readError) throw readError
    const state = { ...(existing?.state || {}) }
    if (remove) delete state[key]
    else state[key] = value
    if (!existing && !Object.keys(state).length) return

    if (!existing) {
      const { error } = await supabase.from('bot_state').insert({
        user_id: userId, state, updated_at: new Date().toISOString()
      })
      if (!error) return
      if (error.code === '23505') continue
      throw error
    }

    const filter = (query) => existing.updated_at
      ? query.eq('updated_at', existing.updated_at)
      : query.is('updated_at', null)
    if (!Object.keys(state).length) {
      const { data, error } = await filter(supabase.from('bot_state')
        .delete().eq('user_id', userId)).select('user_id')
      if (error) throw error
      if (data?.length) return
    } else {
      const previous = Date.parse(existing.updated_at || '')
      const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString()
      const { data, error } = await filter(supabase.from('bot_state')
        .update({ state, updated_at: updatedAt }).eq('user_id', userId)).select('user_id')
      if (error) throw error
      if (data?.length) return
    }
  }
  throw new Error('BOT_STATE_CHANGED_RETRY')
}

const setState = (userId, key, value) => patchState(userId, key, value)
const deleteState = (userId, key) => patchState(userId, key, undefined, true)

async function hasState(userId, key) {
  const val = await getState(userId, key)
  return val !== undefined
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
