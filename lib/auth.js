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

  const { data: existing, error: findError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_hash', hash)
    .maybeSingle()

  if (findError) {
    console.error('[getOrCreateUser] Error finding user by hash for telegramId:', telegramId, findError.message, findError)
    throw findError
  }

  if (existing) return existing

  const { data: newUser, error: insertError } = await supabase
    .from('users')
    .insert({ telegram_hash: hash, telegram_id: String(telegramId) })
    .select()
    .single()

  if (insertError) {
    console.error('[getOrCreateUser] Error creating user for telegramId:', telegramId, insertError.message, insertError)
    throw insertError
  }

  return newUser
}

// Check if a telegram ID belongs to staff
export async function getStaffRole(telegramId) {
  // Always treat ADMIN_TELEGRAM_ID as admin, even if not in staff table
  if (isAdmin(telegramId)) return 'admin'

  const hash = hashTelegramId(telegramId)

  const { data, error } = await supabase
    .from('staff')
    .select('role, is_active')
    .eq('telegram_hash', hash)
    .maybeSingle()

  if (error) {
    console.error('[getStaffRole] telegramId:', telegramId, error.message, error)
    return null
  }

  if (!data || !data.is_active) return null
  return data.role // 'admin' or 'cashier'
}

export function isAdmin(telegramId) {
  return String(telegramId) === String(process.env.ADMIN_TELEGRAM_ID)
}
