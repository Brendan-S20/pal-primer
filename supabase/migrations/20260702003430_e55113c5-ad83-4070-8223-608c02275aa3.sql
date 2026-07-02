ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS ai_voice_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_voice_greeting text
    DEFAULT 'Hi, thanks for calling. I''m the AI assistant. How can I help?';

ALTER TABLE public.ai_receptionist_logs
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS call_sid text,
  ADD COLUMN IF NOT EXISTS turn integer;

CREATE INDEX IF NOT EXISTS ai_receptionist_logs_call_sid_idx
  ON public.ai_receptionist_logs (call_sid, created_at);