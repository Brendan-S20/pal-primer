-- A walk is priced as a walk: the service catalog, phase 5 (pricing).
--
-- Phases 1-4 gave a business a list of services, put one on every plan and
-- visit, and let a plan say which weekdays it runs. Every one of those left
-- the PRICE alone: a plan's price_cents is still typed or prefilled, a public
-- quote still prices from the ZONE whatever is being bought, and the drift
-- report compares a walk against the zone rate card. This file is the one
-- pricing rule for everything that is not pet waste, written once in SQL
-- (here) and once in TypeScript (servicePriceCents, src/lib/services.ts),
-- held to one table by tests/a-walk-is-priced-as-a-walk.test.ts, the way
-- stop_service_min / visitServiceMinutes are.
--
-- ── THE RULE ─────────────────────────────────────────────────────────────
--
--   price = (base + extra_pet × pets beyond the first) × units × multiplier
--
--   units       1 for a flat visit; minutes ÷ 60 for an hourly service (the
--               plan's minutes when given, else the service's own duration);
--               nights for a nightly one (pet sitting only).
--   multiplier  the line's frequency multiplier, which is 1.0 for every line
--               this function prices. Waste accumulates, so a monthly cleanup
--               costs more than a weekly one; a walk costs the same whatever
--               the cadence. The argument exists so the rule is stated in
--               full and the two copies can be tested on it.
--
-- Rounded ONCE, at the end: $20.01/hour for 20 minutes is 667 cents, not two
-- rounded thirds. A half cent rounds up on both sides (round(numeric) takes a
-- positive half away from zero; Math.round takes it up). NULL where there is
-- no price: a NULL base (pet waste priced by zone, or a service nobody has
-- priced yet), an hourly service with no duration anywhere, a multiplier that
-- is not positive. NULL rather than 0, because 0 is a price.
--
-- ── WHAT PET WASTE DOES ──────────────────────────────────────────────────
--
-- Nothing new. The owner's decision: pet waste keeps zone and area pricing
-- exactly as today. A pet-waste service never reaches service_price_cents; it
-- falls through to the zone path everywhere (public_quote below, the drift
-- report, the plan form). Repricing never touches a pet-waste plan.
--
-- ── public_quote GAINS AN OPTIONAL SERVICE ───────────────────────────────
--
-- `_service_id uuid DEFAULT NULL`, after every existing argument, so every
-- caller today (the signup page, the lead form, the AI receptionist) passes
-- what it passed and gets what it got. With it NULL, or naming a pet-waste
-- service, the answer is byte-for-byte what the 20260929120000 body
-- returned: that body is kept verbatim as the fall-through branch, and
-- tests/sql/a-walk-is-priced-as-a-walk.proof.sql captures the row before
-- this file runs and compares it after. With a priced non-waste service it
-- returns that service's price for the dog count, at a multiplier of 1.0,
-- with no first cleanup (a walk has none: mode 'off', 0 cents, no tiers).
-- An unpriced one returns the row with NULL prices -- "we cannot price this
-- yet", which nothing may charge -- and a service of another business, or a
-- deactivated one, returns nothing, the same as an out-of-area ZIP.
--
-- The ZIP still has to match a zone. Zones are where the business works;
-- that does not change when what it sells does.
--
-- The 5-argument function is dropped, not overloaded: PostgREST cannot pick
-- between two public_quote functions when a caller omits the optional
-- arguments (the same reason 20260929120000 dropped the 4-argument one). The
-- fresh object inherits no grant, so anon is granted back below, after the
-- REVOKE, in that order (tests/the-lockdown-that-only-held-...).
--
-- Replays into an empty database: two functions over tables that exist by
-- now. No row is needed, and no number is asserted.

-- ── 1. The rule ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.service_price_cents(
  _price_unit text,
  _base_price_cents integer,
  _extra_pet_cents integer,
  _default_duration_min integer,
  _pets integer DEFAULT 1,
  _minutes integer DEFAULT NULL,
  _nights integer DEFAULT 1,
  _multiplier numeric DEFAULT 1
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _per_unit numeric;
  _mins integer;
BEGIN
  IF _base_price_cents IS NULL THEN RETURN NULL; END IF;
  IF _multiplier IS NULL OR _multiplier <= 0 THEN RETURN NULL; END IF;
  -- A nonsense pet count reads as one pet, never as a discount.
  _per_unit := _base_price_cents
               + COALESCE(_extra_pet_cents, 0) * (GREATEST(COALESCE(_pets, 1), 1) - 1);
  IF _price_unit = 'hour' THEN
    _mins := COALESCE(_minutes, _default_duration_min);
    IF _mins IS NULL OR _mins <= 0 THEN RETURN NULL; END IF;
    RETURN round(_per_unit * _mins * _multiplier / 60)::integer;
  ELSIF _price_unit = 'night' THEN
    RETURN round(_per_unit * GREATEST(COALESCE(_nights, 1), 1) * _multiplier)::integer;
  END IF;
  RETURN round(_per_unit * _multiplier)::integer;
END;
$function$;

COMMENT ON FUNCTION public.service_price_cents(text, integer, integer, integer, integer, integer, integer, numeric) IS
  'One visit of a service, in cents: (base + extra pet × pets beyond the first) × units × multiplier, rounded once. units: 1 per visit, minutes/60 per hour (the given minutes, else the service''s duration), nights per night. NULL when there is no price. Pet waste never comes here; it is priced by zone. Mirrored by servicePriceCents in src/lib/services.ts. Migration 20261011100000.';

REVOKE ALL ON FUNCTION public.service_price_cents(text, integer, integer, integer, integer, integer, integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_price_cents(text, integer, integer, integer, integer, integer, integer, numeric)
  TO authenticated, service_role;

-- ── 2. public_quote, with the service it is quoting ───────────────────────

DROP FUNCTION IF EXISTS public.public_quote(text, text, integer, text, text);

CREATE OR REPLACE FUNCTION public.public_quote(
  _slug text,
  _postal_code text,
  _dog_count integer,
  _frequency text,
  -- The tier the customer picked for "when was your yard last cleaned?". Only
  -- an id: the price is the owner's, read here, never the caller's.
  _last_cleaned text DEFAULT NULL,
  -- The service being quoted (phase 5). NULL, or a pet-waste service, is the
  -- zone quote exactly as before this argument existed.
  _service_id uuid DEFAULT NULL
)
RETURNS TABLE(
  organization_id uuid,
  zone_id uuid,
  zone_name text,
  base_price_cents integer,
  per_dog_addl_cents integer,
  recurring_price_cents integer,
  initial_cleanup_cents integer,
  currency text,
  first_cleanup_mode text,
  first_cleanup_label text,
  first_cleanup_options jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org public.organizations;
  _zone public.zones;
  _svc public.services;
  _mult numeric;
  _base_visit_cents integer;
  _recurring integer;
  _zip text := btrim(coalesce(_postal_code, ''));
  _cfg jsonb;
  _mode text;
BEGIN
  SELECT * INTO _org FROM public.organizations o
    WHERE (o.portal_slug = _slug OR o.slug = _slug)
      AND o.public_signup_enabled = true
      AND o.deleted_at IS NULL
    ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT z.* INTO _zone FROM public.zones z
    WHERE z.organization_id = _org.id
      AND (_zip = ANY(z.zip_codes)
           OR (z.postal_prefix IS NOT NULL AND _zip LIKE z.postal_prefix || '%'))
    ORDER BY (CASE WHEN _zip = ANY(z.zip_codes) THEN 0 ELSE 1 END),
             z.priority DESC,
             (CASE WHEN z.account_type = 'residential' THEN 0
                   WHEN z.account_type IS NULL THEN 1
                   ELSE 2 END),
             length(coalesce(z.postal_prefix,'')) DESC,
             z.id
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  -- The service, when one is named: this business's, or nothing. Another
  -- business's id is the same silence as a ZIP nobody serves.
  IF _service_id IS NOT NULL THEN
    SELECT s.* INTO _svc FROM public.services s
      WHERE s.id = _service_id AND s.organization_id = _org.id;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  IF _svc.id IS NOT NULL AND _svc.service_line <> 'pet_waste' THEN
    -- A walk, a sit, a groom: the service's own price, through the one rule.
    -- Not for sale once deactivated. No frequency multiplier (1.0 for every
    -- line but pet waste), and no first cleanup: that is a yard's.
    IF NOT _svc.active THEN RETURN; END IF;
    _base_visit_cents := public.service_price_cents(
      _svc.price_unit, _svc.base_price_cents, _svc.extra_pet_cents,
      _svc.default_duration_min, _dog_count, NULL, 1, 1);

    organization_id := _org.id;
    zone_id := _zone.id;
    zone_name := _zone.name;
    base_price_cents := _base_visit_cents;
    -- Per dog PER VISIT, like the zone's per_dog_addl_cents: the extra-pet
    -- rate × the same units (the service's duration for an hourly service,
    -- one night for a nightly one), so a "+$X per dog" label is right.
    per_dog_addl_cents := public.service_price_cents(
      _svc.price_unit, _svc.extra_pet_cents, 0, _svc.default_duration_min, 1, NULL, 1, 1);
    recurring_price_cents := _base_visit_cents;
    initial_cleanup_cents := 0;
    currency := _org.currency;
    first_cleanup_mode := 'off';
    first_cleanup_label := NULL;
    first_cleanup_options := '[]'::jsonb;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Pet waste, or no service named: the 20260929120000 body, verbatim.
  _mult := COALESCE((_org.frequency_multipliers ->> _frequency)::numeric, 1.0);
  _base_visit_cents := _zone.base_price_cents + GREATEST(_dog_count - 1, 0) * _zone.per_dog_addl_cents;
  _recurring := round(_base_visit_cents * _mult)::integer;

  _cfg := COALESCE(_org.first_cleanup_pricing, '{"mode":"off"}'::jsonb);
  _mode := COALESCE(_cfg ->> 'mode', 'off');

  organization_id := _org.id;
  zone_id := _zone.id;
  zone_name := _zone.name;
  base_price_cents := _base_visit_cents;
  per_dog_addl_cents := _zone.per_dog_addl_cents;
  recurring_price_cents := _recurring;
  initial_cleanup_cents := public.first_cleanup_price_cents(
    _cfg, _zone.initial_cleanup_cents, _dog_count, _last_cleaned);
  currency := _org.currency;
  first_cleanup_mode := _mode;
  first_cleanup_label := CASE WHEN _mode = 'by_last_cleaned' THEN (
      SELECT t ->> 'label' FROM jsonb_array_elements(COALESCE(_cfg -> 'tiers', '[]'::jsonb)) AS e(t)
       WHERE t ->> 'id' = _last_cleaned LIMIT 1) END;
  first_cleanup_options := CASE WHEN _mode = 'by_last_cleaned' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t ->> 'id',
               'label', t ->> 'label',
               'price_cents', public.first_cleanup_price_cents(
                  _cfg, _zone.initial_cleanup_cents, _dog_count, t ->> 'id')
             ) ORDER BY ord)
        FROM jsonb_array_elements(_cfg -> 'tiers') WITH ORDINALITY AS e(t, ord)), '[]'::jsonb)
    ELSE '[]'::jsonb END;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.public_quote(text, text, integer, text, text, uuid) IS
  'The public price for a visitor: the zone''s rate card for pet waste (or when no service is named), the service''s own price (service_price_cents) for any other service. Anon-callable; takes no price. Migration 20261011100000 added _service_id.';

REVOKE ALL ON FUNCTION public.public_quote(text, text, integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text, text, uuid)
  TO anon, authenticated, service_role;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _r record;
  _got integer;
  _n integer := 0;
BEGIN
  -- The table. tests/a-walk-is-priced-as-a-walk.test.ts reads these rows
  -- off this file and runs servicePriceCents over the same ones, so the two
  -- copies of the rule cannot drift apart: a row added here is a row the
  -- TypeScript has to agree with, and the other way round.
  --   unit, base, extra, duration, pets, minutes, nights, multiplier -> want
  FOR _r IN
    SELECT * FROM (VALUES
      ('visit', 2500,          500, 30,            1, NULL::integer, 1, 1::numeric, 2500),          -- a walk
      ('visit', 2500,          500, 30,            3, NULL,          1, 1,          3500),          -- two extra dogs
      ('visit', 2500,          500, 30,            0, NULL,          1, 1,          2500),          -- a nonsense count reads as one
      ('visit', 2500,          500, 30,            1, NULL,          1, 2,          5000),          -- a multiplier (no live line has one)
      ('hour',  2000,          0,   60,            1, 45,            1, 1,          1500),          -- 45 minutes at $20/hour
      ('hour',  2000,          0,   30,            1, NULL,          1, 1,          1000),          -- the service's own duration
      ('hour',  2001,          0,   60,            1, 20,            1, 1,          667),           -- rounded once, at the end
      ('hour',  1,             0,   60,            1, 30,            1, 1,          1),             -- a half cent rounds up
      ('hour',  3000,          600, 90,            2, NULL,          1, 1,          5400),          -- extra pets are per hour too
      ('hour',  2000,          0,   NULL,          1, NULL,          1, 1,          NULL),          -- no duration anywhere is no price
      ('night', 6000,          1500, 720,          2, NULL,          3, 1,          22500),         -- three nights, two pets
      ('night', 6000,          1500, NULL,         1, NULL,          1, 1,          6000),          -- one night: a visit
      ('visit', NULL,          500, 30,            1, NULL,          1, 1,          NULL),          -- no price: by zone, or not set
      ('visit', 2500,          500, 30,            1, NULL,          1, 0,          NULL)           -- a multiplier of nothing prices nothing
    ) AS t(unit, base, extra, dur, pets, mins, nights, mult, want)
  LOOP
    _n := _n + 1;
    _got := public.service_price_cents(_r.unit, _r.base, _r.extra, _r.dur, _r.pets, _r.mins, _r.nights, _r.mult);
    IF _got IS DISTINCT FROM _r.want THEN
      RAISE EXCEPTION 'service_price_cents(%, %, %, %, pets %, minutes %, nights %, × %) = %, expected %',
        _r.unit, _r.base, _r.extra, _r.dur, _r.pets, _r.mins, _r.nights, _r.mult, _got, _r.want;
    END IF;
  END LOOP;
  IF _n <> 14 THEN
    RAISE EXCEPTION 'the pricing table has % rows; the TypeScript test expects 14', _n;
  END IF;

  -- One public_quote, the six-argument one, and anon can call it and only it.
  IF to_regprocedure('public.public_quote(text, text, integer, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'the five-argument public_quote is still there; PostgREST cannot choose between two';
  END IF;
  IF to_regprocedure('public.public_quote(text, text, integer, text, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'public_quote(text, text, integer, text, text, uuid) was not created';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on public_quote; the signup page cannot price a visit';
  END IF;
  IF has_function_privilege('anon', 'public.service_price_cents(text, integer, integer, integer, integer, integer, integer, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call service_price_cents directly';
  END IF;
  -- Still no way to hand public_quote a price (the first-cleanup proof's rule).
  IF (SELECT pg_get_function_arguments('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure)) ~* 'cents' THEN
    RAISE EXCEPTION 'public_quote takes a price argument';
  END IF;
END
$post$;
