-- bot_state_migration.sql
-- Run this in your Supabase SQL Editor to create the table required for Phase 3.

CREATE TABLE public.bot_state (
  user_id bigint NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT bot_state_pkey PRIMARY KEY (user_id)
);

-- Enable RLS and add a policy if you are using RLS
ALTER TABLE public.bot_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations for service role" ON public.bot_state
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
