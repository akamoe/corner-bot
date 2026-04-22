import crypto from 'crypto'
import supabase from './supabase.js'

// One-way hash of telegram ID — this is all we store
export function hashTelegramId(telegramId) {
  return crypto
    .createHash('sha256')
    .update(String(telegramId))
    .digest('hex')
}

// Get or create a user by their hashed telegram ID
export async function getOrCreateUser(telegramId) {
  const hash = hashTelegramId(telegramId)

  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_hash', hash)
    .single()

  if (existing) return existing

  const { data: newUser } = await supabase
    .from('users')
    .insert({ telegram_hash: hash })
    .select()
    .single()

  return newUser
}

// Check if a telegram ID belongs to staff
export async function getStaffRole(telegramId) {
  const hash = hashTelegramId(telegramId)

  const { data } = await supabase
    .from('staff')
    .select('role, is_active')
    .eq('telegram_hash', hash)
    .single()

  if (!data || !data.is_active) return null
  return data.role // 'admin' or 'cashier'
}

export function isAdmin(telegramId) {
  return String(telegramId) === String(process.env.ADMIN_TELEGRAM_ID)
}