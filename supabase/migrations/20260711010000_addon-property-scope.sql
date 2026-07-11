-- Finding #29 (remainder): associate portal add-on purchases with a specific
-- property so a 2+ property client can say which address an add-on applies to.
-- Additive + idempotent: property_id is nullable; existing rows stay
-- account-level (NULL) and behave exactly as before.

alter table public.addon_subscriptions
  add column if not exists property_id uuid references public.properties(id);
alter table public.addon_charges
  add column if not exists property_id uuid references public.properties(id);

-- portal_subscribe_addon: accept an optional _property_id, validate it belongs
-- to the calling client, and stamp it on the created charge/subscription.
-- Signature changes (new param) so the 4-arg version must be dropped first.
drop function if exists public.portal_subscribe_addon(uuid, uuid, addon_frequency, integer);

create or replace function public.portal_subscribe_addon(
  _token uuid,
  _addon_service_id uuid,
  _frequency addon_frequency,
  _quantity integer,
  _property_id uuid default null
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  IF _svc.kind = 'one_time' THEN
    INSERT INTO public.addon_charges(organization_id, client_id, addon_service_id,
      property_id, description, unit_price_cents, quantity, amount_cents, source)
    VALUES (_org, _cid, _svc.id, _property_id, _svc.name, _svc.unit_price_cents, _q,
      _svc.unit_price_cents * _q, 'office')
    RETURNING id INTO _id;
    RETURN _id;
  END IF;

  IF _frequency IS NULL AND _svc.default_frequency IS NULL THEN
    RAISE EXCEPTION 'Frequency required for this add-on';
  END IF;
  INSERT INTO public.addon_subscriptions(organization_id, client_id, addon_service_id,
    property_id, frequency, price_cents, quantity, next_charge_on, status)
  VALUES (_org, _cid, _svc.id, _property_id, COALESCE(_frequency, _svc.default_frequency),
    _svc.unit_price_cents, _q, CURRENT_DATE, 'active')
  RETURNING id INTO _id;
  RETURN _id;
END; $function$;

-- portal_list_client_addons: surface which property each add-on covers so the
-- portal can label it. Return shape changes (new column) so drop first.
drop function if exists public.portal_list_client_addons(uuid);

create or replace function public.portal_list_client_addons(_token uuid)
 returns table(addon_subscription_id uuid, addon_service_id uuid, name text,
   frequency addon_frequency, price_cents integer, quantity integer,
   next_charge_on date, status text, property_label text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT s.id, s.addon_service_id, a.name, s.frequency, s.price_cents,
         s.quantity, s.next_charge_on, s.status, p.label
    FROM public.clients c
    JOIN public.addon_subscriptions s ON s.client_id = c.id
    JOIN public.addon_services a ON a.id = s.addon_service_id
    LEFT JOIN public.properties p ON p.id = s.property_id
   WHERE c.portal_token = _token AND c.active = true
   ORDER BY s.status, a.name;
$function$;
