import supabase from './supabase.js'

async function getState(userId, key) {
  const { data, error } = await supabase
    .from('bot_state')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle()
  
  if (error) console.error('getState error:', error)
  
  if (error || !data) return undefined
  return data.state?.[key]
}

async function setState(userId, key, value) {
  const { data: existing } = await supabase
    .from('bot_state')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle()

  const newState = existing?.state || {}
  newState[key] = value

  const { error } = await supabase
    .from('bot_state')
    .upsert({ user_id: userId, state: newState, updated_at: new Date().toISOString() })
  if (error) console.error('setState error:', error.message)
}

async function deleteState(userId, key) {
  const { data: existing } = await supabase
    .from('bot_state')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle()

  if (!existing?.state) return
  
  const newState = existing.state
  delete newState[key]

  if (Object.keys(newState).length === 0) {
    await supabase.from('bot_state').delete().eq('user_id', userId)
  } else {
    await supabase
      .from('bot_state')
      .upsert({ user_id: userId, state: newState, updated_at: new Date().toISOString() })
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
