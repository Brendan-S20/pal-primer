
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS sms_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS sms_from_number text;

CREATE TYPE public.message_direction AS ENUM ('outbound','inbound');
CREATE TYPE public.message_status AS ENUM ('queued','sent','delivered','failed','received');

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  visit_id uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  direction public.message_direction NOT NULL,
  body text NOT NULL,
  from_number text,
  to_number text,
  twilio_sid text UNIQUE,
  status public.message_status NOT NULL DEFAULT 'queued',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.messages(organization_id, created_at DESC);
CREATE INDEX ON public.messages(client_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read messages"
  ON public.messages FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "managers insert outbound"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org(auth.uid(), organization_id) AND direction = 'outbound');

CREATE POLICY "managers update messages"
  ON public.messages FOR UPDATE TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id));

CREATE TRIGGER tg_messages_touch BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Helper: normalize a phone to a comparable form (digits only)
CREATE OR REPLACE FUNCTION public.phone_digits(_p text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(COALESCE(_p,''), '\D', '', 'g');
$$;
