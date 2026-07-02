
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS ai_receptionist_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_receptionist_faq text,
  ADD COLUMN IF NOT EXISTS ai_receptionist_persona text
    DEFAULT 'You are a friendly, concise SMS receptionist for a pet-waste cleanup company. Answer in 1-2 short sentences. Never invent prices — use the get_pricing_quote tool. Offer to have a human follow up when unsure.';

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS ai_handled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.ai_receptionist_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  inbound_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  outbound_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  from_number text,
  user_text text,
  reply_text text,
  tool_calls jsonb,
  model text,
  latency_ms integer,
  error text,
  escalated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ai_receptionist_logs TO authenticated;
GRANT ALL ON public.ai_receptionist_logs TO service_role;

ALTER TABLE public.ai_receptionist_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read ai logs"
  ON public.ai_receptionist_logs FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS ai_receptionist_logs_org_created_idx
  ON public.ai_receptionist_logs (organization_id, created_at DESC);
