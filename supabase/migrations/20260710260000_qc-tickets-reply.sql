-- Concern reply-to-client (#14): record the last reply sent to the client so
-- the inbox shows it was answered (the message itself goes out by email).
-- Applied to live via Supabase MCP 2026-07-10.
ALTER TABLE public.qc_tickets
  ADD COLUMN IF NOT EXISTS last_reply text,
  ADD COLUMN IF NOT EXISTS last_reply_at timestamptz;
