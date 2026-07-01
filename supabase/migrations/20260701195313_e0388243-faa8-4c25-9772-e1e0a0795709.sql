
CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  company text,
  location text,
  dog_count int,
  frequency text,
  message text,
  source text NOT NULL DEFAULT 'website',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','converted','archived')),
  contacted_at timestamptz,
  converted_at timestamptz,
  CONSTRAINT leads_email_chk CHECK (char_length(email) BETWEEN 3 AND 255),
  CONSTRAINT leads_name_chk CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT leads_message_chk CHECK (message IS NULL OR char_length(message) <= 2000)
);

GRANT INSERT ON public.leads TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO authenticated;
GRANT ALL ON public.leads TO service_role;

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit a lead"
  ON public.leads FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can read leads"
  ON public.leads FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can update leads"
  ON public.leads FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete leads"
  ON public.leads FOR DELETE TO authenticated USING (true);

CREATE TRIGGER tg_leads_updated_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE INDEX idx_leads_status_created ON public.leads (status, created_at DESC);
