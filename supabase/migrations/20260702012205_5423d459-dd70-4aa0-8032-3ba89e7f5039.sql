
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS default_payment_method_id text,
  ADD COLUMN IF NOT EXISTS default_card_brand text,
  ADD COLUMN IF NOT EXISTS default_card_last4 text,
  ADD COLUMN IF NOT EXISTS autopay_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS autopay_last_error text,
  ADD COLUMN IF NOT EXISTS autopay_last_attempt_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS clients_stripe_customer_id_key
  ON public.clients(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.portal_get_client(uuid);

CREATE FUNCTION public.portal_get_client(_token uuid)
RETURNS TABLE(client_id uuid, organization_id uuid, display_name text,
              account_type text, credit_balance_cents integer, org_name text,
              autopay_enabled boolean, has_saved_card boolean,
              card_brand text, card_last4 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.organization_id, c.display_name, c.account_type::text,
         c.credit_balance_cents, o.name,
         c.autopay_enabled,
         (c.default_payment_method_id IS NOT NULL) AS has_saved_card,
         c.default_card_brand, c.default_card_last4
    FROM public.clients c JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true
$$;

GRANT EXECUTE ON FUNCTION public.portal_get_client(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_set_autopay(_token uuid, _enabled boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _client_id uuid; _has_pm boolean;
BEGIN
  SELECT id, (default_payment_method_id IS NOT NULL)
    INTO _client_id, _has_pm
    FROM public.clients WHERE portal_token = _token AND active = true;
  IF _client_id IS NULL THEN RAISE EXCEPTION 'invalid portal token'; END IF;
  IF _enabled AND NOT _has_pm THEN
    RAISE EXCEPTION 'add a payment method before enabling autopay';
  END IF;
  UPDATE public.clients SET autopay_enabled = _enabled WHERE id = _client_id;
  RETURN _enabled;
END $$;

GRANT EXECUTE ON FUNCTION public.portal_set_autopay(uuid, boolean) TO anon, authenticated;
