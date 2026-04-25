import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/rest\/v1\/?$/, '')

const supabase = createClient(
  supabaseUrl,
  process.env.SUPABASE_ANON_KEY
)

export default supabase