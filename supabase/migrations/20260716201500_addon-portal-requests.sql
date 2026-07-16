-- QA round 8 (add-on flow): staff-added add-ons are billable immediately
-- (a one-time charge's 'pending' status just means "unbilled, goes on the
-- next invoice" — no acceptance step), while CLIENT PORTAL requests must be
-- approved by staff before anything becomes billable.
--
-- Until now portal_subscribe_addon created live charges/subscriptions
-- directly. It now records a request in addon_requests; staff approve or
-- decline from the client detail page.

CREATE TABLE public.addon_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  addon_service_id uuid NOT NULL REFERENCES public.addon_services(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL,
  kind public.addon_kind NOT NULL,
  frequency public.addon_frequency,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Price snapshot at request time so a later catalog change can't silently
  -- reprice what the client agreed to.
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  decided_by uuid,
  decided_at timestamptz,
  decline_reason text CHECK (char_length(decline_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX addon_requests_client_idx ON public.addon_requests (client_id, status, created_at DESC);
CREATE INDEX addon_requests_org_idx ON public.addon_requests (organization_id, status);

ALTER TABLE public.addon_requests ENABLE ROW LEVEL SECURITY;

-- Org members read; office roles decide. Inserts come only from the
-- SECURITY DEFINER portal function below (no authenticated insert path).
CREATE POLICY addon_requests_select ON public.addon_requests
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY addon_requests_write ON public.addon_requests
  FOR UPDATE TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

GRANT SELECT, UPDATE ON public.addon_requests TO authenticated;
GRANT ALL ON public.addon_requests TO service_role;

-- ── portal_subscribe_addon: record a request instead of a live add-on ──────
-- Same signature as 20260711010000_addon-property-scope.sql; returns the
-- request id.

CREATE OR REPLACE FUNCTION public.portal_subscribe_addon(
  _token uuid,
  _addon_service_id uuid,
  _frequency addon_frequency,
  _quantity integer,
  _property_id uuid DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _cid uuid; _org uuid; _svc record; _id uuid; _q integer;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  _q := GREATEST(1, COALESCE(_quantity, 1));

  -- A supplied property must belong to this client (prevents pointing an
  -- add-on at another account's property).
  IF _property_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.properties WHERE id = _property_id AND client_id = _cid
  ) THEN RAISE EXCEPTION 'Property not found'; END IF;

  SELECT * INTO _svc FROM public.addon_services
   WHERE id = _addon_service_id AND organization_id = _org AND active = true;
  IF _svc.id IS NULL THEN RAISE EXCEPTION 'Add-on unavailable'; END IF;

  IF _svc.kind = 'recurring' AND _frequency IS NULL AND _svc.default_frequency IS NULL THEN
    RAISE EXCEPTION 'Frequency required for this add-on';
  END IF;

  -- Nothing becomes billable here: staff approve or decline the request
  -- from the client detail page.
  INSERT INTO public.addon_requests(
    organization_id, client_id, addon_service_id, property_id, kind,
    frequency, quantity, unit_price_cents)
  VALUES (_org, _cid, _svc.id, _property_id, _svc.kind,
    CASE WHEN _svc.kind = 'recurring' THEN COALESCE(_frequency, _svc.default_frequency) END,
    _q, _svc.unit_price_cents)
  RETURNING id INTO _id;
  RETURN _id;
END; $function$;

GRANT EXECUTE ON FUNCTION public.portal_subscribe_addon(uuid, uuid, public.addon_frequency, integer, uuid) TO anon, authenticated;

-- portal_cancel_addon: a client can also withdraw a still-pending request by
-- its id (the portal calls this with whatever id the list handed back).
CREATE OR REPLACE FUNCTION public.portal_cancel_addon(
  _token uuid, _addon_subscription_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid;
BEGIN
  SELECT id INTO _cid FROM public.clients WHERE portal_token = _token AND active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  UPDATE public.addon_subscriptions
     SET status = 'canceled', updated_at = now()
   WHERE id = _addon_subscription_id AND client_id = _cid;
  DELETE FROM public.addon_requests
   WHERE id = _addon_subscription_id AND client_id = _cid AND status = 'pending';
END; $$;
