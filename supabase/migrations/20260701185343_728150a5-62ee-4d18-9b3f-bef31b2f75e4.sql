
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS google_review_url text,
  ADD COLUMN IF NOT EXISTS review_ask_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS referral_reward_cents integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS review_ask_template text;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS referral_code text,
  ADD COLUMN IF NOT EXISTS referred_by_client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_asked_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_submitted_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS clients_referral_code_org_uniq
  ON public.clients(organization_id, lower(referral_code))
  WHERE referral_code IS NOT NULL;

-- Loosen credit_ledger kind check to allow referral entries
ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE public.credit_ledger ADD CONSTRAINT credit_ledger_kind_check
  CHECK (kind = ANY (ARRAY['prepayment','visit_debit','refund','adjustment','referral_reward','referral_bonus']));

-- Auto-generate a short referral code on insert
CREATE OR REPLACE FUNCTION public.tg_clients_gen_referral_code()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _try text; _n int := 0;
BEGIN
  IF NEW.referral_code IS NOT NULL THEN RETURN NEW; END IF;
  LOOP
    _try := upper(substr(replace(encode(gen_random_bytes(4),'base64'),'/',''), 1, 6));
    _try := regexp_replace(_try, '[^A-Z0-9]', 'X', 'g');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.clients
       WHERE organization_id = NEW.organization_id AND lower(referral_code) = lower(_try)
    );
    _n := _n + 1;
    IF _n > 8 THEN _try := _try || floor(random()*1000)::text; EXIT; END IF;
  END LOOP;
  NEW.referral_code := _try;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS clients_gen_referral_code ON public.clients;
CREATE TRIGGER clients_gen_referral_code
  BEFORE INSERT ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.tg_clients_gen_referral_code();

-- Backfill referral codes for existing rows
UPDATE public.clients SET referral_code = upper(substr(md5(id::text || random()::text),1,6))
 WHERE referral_code IS NULL;

-- Mark review asked (idempotent per client per 90 days)
CREATE OR REPLACE FUNCTION public.mark_review_asked(_client_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _last timestamptz;
BEGIN
  SELECT organization_id, review_asked_at INTO _org, _last FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _last IS NOT NULL AND _last > now() - INTERVAL '90 days' THEN
    RETURN false;
  END IF;
  UPDATE public.clients SET review_asked_at = now(), updated_at = now() WHERE id = _client_id;
  RETURN true;
END; $$;

-- Apply a referral code to a client (grants credit to both parties)
CREATE OR REPLACE FUNCTION public.apply_referral_code(_new_client_id uuid, _code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _reward int; _referrer uuid; _already timestamptz;
BEGIN
  SELECT organization_id, referral_applied_at INTO _org, _already FROM public.clients WHERE id = _new_client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _already IS NOT NULL THEN RAISE EXCEPTION 'Referral already applied for this client'; END IF;

  SELECT id FROM public.clients
   WHERE organization_id = _org AND lower(referral_code) = lower(trim(_code)) AND id <> _new_client_id
   INTO _referrer;
  IF _referrer IS NULL THEN RAISE EXCEPTION 'Referral code not found'; END IF;

  SELECT referral_reward_cents INTO _reward FROM public.organizations WHERE id = _org;
  IF _reward IS NULL OR _reward <= 0 THEN _reward := 0; END IF;

  UPDATE public.clients
     SET referred_by_client_id = _referrer,
         referral_applied_at = now(),
         updated_at = now()
   WHERE id = _new_client_id;

  IF _reward > 0 THEN
    PERFORM public.post_credit_entry(_org, _new_client_id, _reward, 'referral_bonus', NULL, NULL,
      'Welcome credit from referral code ' || upper(trim(_code)));
    PERFORM public.post_credit_entry(_org, _referrer, _reward, 'referral_reward', NULL, NULL,
      'Referral reward for new client');
  END IF;

  RETURN jsonb_build_object('referrer_id', _referrer, 'reward_cents', _reward);
END; $$;
