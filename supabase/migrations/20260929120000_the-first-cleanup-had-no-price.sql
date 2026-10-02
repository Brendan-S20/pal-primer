-- The first cleanup had no price.
--
-- Found 2026-09-29 by the product review. Sweep&Go's signup asks "when was
-- your yard last cleaned?" and prices the first visit from the answer, because
-- a yard nobody has touched since the snow melted is two hours of work and a
-- yard cleaned last Tuesday is twenty minutes. HoundStack had one number per
-- zone, `zones.initial_cleanup_cents`, and the owner's decision on it was:
-- "build it out, but leave it up to the company on how it should be priced."
--
-- ── WHAT THE ZONE FIELD ACTUALLY DID, READ RATHER THAN ASSUMED ─────────────
--
-- The review said the field was never offered to a customer. It was, on one
-- path: `public_quote` returned it, the /signup/{slug} page showed it as
-- "First cleanup (one-time)", and `createSignupPaymentIntent` charged it on top
-- of the first visit. What it did NOT do is get written down anywhere after
-- the card was charged. The webhook credited the prepaid visit to the
-- customer's balance and dropped the rest on the floor: no invoice, no line,
-- no payment row, so the first cleanup was money in the tenant's Stripe
-- balance that no report in HoundStack could see. And the zone column defaults
-- to 7500, so every zone anybody created without reading that field was
-- selling a $75 first cleanup it never mentioned to its owner.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--
--   organizations.first_cleanup_pricing   jsonb, validated:
--       { mode: 'off' | 'flat' | 'by_last_cleaned',
--         tiers: [{ id, label, price_cents }],     -- by_last_cleaned
--         per_extra_dog_cents: int }                -- optional add-on
--
--     off              no first-cleanup charge anywhere.
--     flat             the zone's own `initial_cleanup_cents`. Per zone,
--                      because that is what the existing field already is.
--     by_last_cleaned  the owner's tiers, organization-wide. The zone field is
--                      one integer and cannot hold a tier list, so a per-zone
--                      override would be a new table for a need nobody has
--                      stated; an owner who wants different tiers per area
--                      has flat-per-zone as the alternative.
--     per_extra_dog    added once per dog beyond the first, in both priced
--                      modes, on top of a price above zero. A tier the owner
--                      priced at $0 is free, not "free plus $10 a dog".
--
--   signup_requests.first_cleanup_tier_id / first_cleanup_label
--     what the customer answered, so the webhook can write the invoice line
--     in the owner's words as they read the day the customer paid.
--
--   public_quote(..., _last_cleaned text DEFAULT NULL)
--     prices the first cleanup from the TIER ID, on the server. The browser
--     never sends a price: createSignupPaymentIntent charges what this
--     returns. In by_last_cleaned mode with no tier (or an unknown one)
--     `initial_cleanup_cents` is NULL — "we cannot price this yet", which the
--     signup refuses to charge — and `first_cleanup_options` lists each tier
--     priced for this zone and dog count so the page can show them.
--
-- ── THE DEFAULT, AND WHY IT IS NOT 'off' FOR EVERYONE ──────────────────────
--
-- The column defaults to {"mode":"off"}, as decided. But "off for existing
-- businesses, so nothing changes until an owner opts in" and "off for every
-- existing row" are different statements for any tenant whose signup page is
-- live today: that page charges the zone's first cleanup right now, and 'off'
-- would stop it overnight. So those rows — public signup enabled, some zone
-- priced above zero — are set to 'flat', which prices exactly what they charge
-- today. Every other existing row keeps 'off', which is also what it charges
-- today: nothing, because no customer could reach a price.
--
-- That UPDATE is data, not an assertion, so it replays into an empty database
-- as a no-op, which is correct.
--
-- ── public_quote's signature ───────────────────────────────────────────────
--
-- DROPPED and recreated with a fifth, defaulted argument rather than
-- overloaded: two signatures would make every four-argument call ambiguous
-- (20260804060000; 20260929040000 did the same for complete_visit). Every
-- existing caller — the signup page, and the AI receptionist's price tool —
-- passes four named arguments, which resolve to the new function through the
-- default. The return gains three columns at the end; nobody selects by
-- position. The grants are restated because a dropped function takes its
-- grants with it, and PUBLIC is revoked because a new function arrives
-- executable by PUBLIC (see the-lockdown-that-only-held-for-the-functions-
-- that-existed-that-day.test.ts).

-- ── The shape of a pricing config, in one place ────────────────────────────
-- A CHECK cannot hold a subquery, so the rule is a function. The limits are
-- repeated in src/lib/first-cleanup.ts so the settings screen refuses what the
-- CHECK would refuse, with a sentence instead of a constraint name.
CREATE OR REPLACE FUNCTION public.first_cleanup_pricing_is_valid(_cfg jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _cfg IS NULL OR jsonb_typeof(_cfg) <> 'object' THEN false
    WHEN jsonb_typeof(_cfg -> 'mode') IS DISTINCT FROM 'string' THEN false
    WHEN (_cfg ->> 'mode') NOT IN ('off', 'flat', 'by_last_cleaned') THEN false
    -- per_extra_dog_cents: absent, or a whole number of cents, 0..$1,000.
    -- Type first, in its own WHEN: CASE fixes the order its branches are
    -- tried in, and OR does not, so a cast beside the type test could run on
    -- a string and raise instead of answering false.
    WHEN _cfg ? 'per_extra_dog_cents'
         AND jsonb_typeof(_cfg -> 'per_extra_dog_cents') <> 'number' THEN false
    WHEN _cfg ? 'per_extra_dog_cents' AND (
           (_cfg ->> 'per_extra_dog_cents')::numeric
             <> trunc((_cfg ->> 'per_extra_dog_cents')::numeric)
        OR (_cfg ->> 'per_extra_dog_cents')::numeric NOT BETWEEN 0 AND 100000
      ) THEN false
    -- tiers: absent, or an array of at most 8.
    WHEN _cfg ? 'tiers' AND jsonb_typeof(_cfg -> 'tiers') IS DISTINCT FROM 'array' THEN false
    WHEN _cfg ? 'tiers' AND jsonb_array_length(_cfg -> 'tiers') > 8 THEN false
    -- Tiered pricing with no tiers would be a question with no answers.
    WHEN (_cfg ->> 'mode') = 'by_last_cleaned'
         AND COALESCE(jsonb_array_length(
               CASE WHEN jsonb_typeof(_cfg -> 'tiers') = 'array' THEN _cfg -> 'tiers' END), 0) = 0
      THEN false
    WHEN NOT (_cfg ? 'tiers') THEN true
    ELSE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(_cfg -> 'tiers') AS e(t)
            WHERE CASE
                    WHEN jsonb_typeof(t) <> 'object' THEN true
                    WHEN jsonb_typeof(t -> 'id') IS DISTINCT FROM 'string'
                      OR jsonb_typeof(t -> 'label') IS DISTINCT FROM 'string'
                      OR jsonb_typeof(t -> 'price_cents') IS DISTINCT FROM 'number' THEN true
                    ELSE (t ->> 'id') !~ '^[a-z0-9][a-z0-9_-]{0,39}$'
                      OR char_length(btrim(t ->> 'label')) NOT BETWEEN 1 AND 80
                      OR (t ->> 'price_cents')::numeric <> trunc((t ->> 'price_cents')::numeric)
                      OR (t ->> 'price_cents')::numeric NOT BETWEEN 0 AND 1000000
                  END
         )
     AND (SELECT count(DISTINCT t ->> 'id') FROM jsonb_array_elements(_cfg -> 'tiers') AS e(t))
         = jsonb_array_length(_cfg -> 'tiers')
  END;
$function$;

REVOKE ALL ON FUNCTION public.first_cleanup_pricing_is_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.first_cleanup_pricing_is_valid(jsonb) TO authenticated, service_role;

-- ── The price, in one place ────────────────────────────────────────────────
-- Pure: the config, the zone's flat price, the dog count and the tier the
-- customer picked. NULL means "cannot price this": tiered mode with no tier,
-- or a tier id the owner does not have. Mirrored by firstCleanupPriceCents in
-- src/lib/first-cleanup.ts for the office screens, which prefill a price the
-- office can still change; the public signup charges only what THIS returns.
CREATE OR REPLACE FUNCTION public.first_cleanup_price_cents(
  _cfg jsonb,
  _zone_flat_cents integer,
  _dog_count integer,
  _tier_id text
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  _mode text := COALESCE(_cfg ->> 'mode', 'off');
  _base integer;
  _per_dog integer := COALESCE((_cfg ->> 'per_extra_dog_cents')::integer, 0);
BEGIN
  IF _mode = 'flat' THEN
    _base := GREATEST(COALESCE(_zone_flat_cents, 0), 0);
  ELSIF _mode = 'by_last_cleaned' THEN
    IF _tier_id IS NULL THEN RETURN NULL; END IF;
    SELECT (t ->> 'price_cents')::integer INTO _base
      FROM jsonb_array_elements(COALESCE(_cfg -> 'tiers', '[]'::jsonb)) AS e(t)
     WHERE t ->> 'id' = _tier_id
     LIMIT 1;
    IF _base IS NULL THEN RETURN NULL; END IF;
  ELSE
    RETURN 0;
  END IF;

  -- A first cleanup priced at nothing is free, not "free plus the dogs".
  IF _base <= 0 THEN RETURN 0; END IF;
  RETURN _base + GREATEST(COALESCE(_dog_count, 1) - 1, 0) * GREATEST(_per_dog, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.first_cleanup_price_cents(jsonb, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.first_cleanup_price_cents(jsonb, integer, integer, text)
  TO authenticated, service_role;

-- ── The column ─────────────────────────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS first_cleanup_pricing jsonb NOT NULL DEFAULT '{"mode":"off"}'::jsonb;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_first_cleanup_pricing_shape;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_first_cleanup_pricing_shape
  CHECK (public.first_cleanup_pricing_is_valid(first_cleanup_pricing));

COMMENT ON COLUMN public.organizations.first_cleanup_pricing IS
  'How a new customer''s first cleanup is priced: {mode: off|flat|by_last_cleaned, tiers: [{id, label, price_cents}], per_extra_dog_cents}. flat uses each zone''s initial_cleanup_cents; by_last_cleaned uses the tiers, org-wide.';

-- Nothing changes for a live signup page: see the header.
UPDATE public.organizations o
   SET first_cleanup_pricing = '{"mode":"flat"}'::jsonb
 WHERE o.public_signup_enabled = true
   AND o.first_cleanup_pricing = '{"mode":"off"}'::jsonb
   AND EXISTS (SELECT 1 FROM public.zones z
                WHERE z.organization_id = o.id AND z.initial_cleanup_cents > 0);

ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS first_cleanup_tier_id text,
  ADD COLUMN IF NOT EXISTS first_cleanup_label text;

COMMENT ON COLUMN public.signup_requests.first_cleanup_tier_id IS
  'The answer to "when was your yard last cleaned?", as the owner''s tier id. NULL when the org does not price by it.';
COMMENT ON COLUMN public.signup_requests.first_cleanup_label IS
  'That tier''s label as it read when the customer paid; the first-cleanup invoice line quotes it.';

-- ── public_quote, pricing the first cleanup ────────────────────────────────
DROP FUNCTION IF EXISTS public.public_quote(text, text, integer, text);

CREATE OR REPLACE FUNCTION public.public_quote(
  _slug text,
  _postal_code text,
  _dog_count integer,
  _frequency text,
  -- The tier the customer picked for "when was your yard last cleaned?". Only
  -- an id: the price is the owner's, read here, never the caller's.
  _last_cleaned text DEFAULT NULL
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

REVOKE ALL ON FUNCTION public.public_quote(text, text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text, text)
  TO anon, authenticated, service_role;

-- ── What this file establishes ─────────────────────────────────────────────
DO $check$
DECLARE
  _tiers jsonb := '{"mode":"by_last_cleaned","per_extra_dog_cents":1000,"tiers":[
      {"id":"week","label":"Within a week","price_cents":4500},
      {"id":"month","label":"1-4 weeks","price_cents":7500},
      {"id":"free","label":"Cleaned yesterday","price_cents":0}]}';
BEGIN
  -- The shape.
  IF NOT public.first_cleanup_pricing_is_valid('{"mode":"off"}') THEN
    RAISE EXCEPTION 'the default config is refused by its own CHECK';
  END IF;
  IF NOT public.first_cleanup_pricing_is_valid(_tiers) THEN
    RAISE EXCEPTION 'a well-formed tier list is refused';
  END IF;
  IF public.first_cleanup_pricing_is_valid('{"mode":"by_last_cleaned"}')
     OR public.first_cleanup_pricing_is_valid('{"mode":"by_last_cleaned","tiers":[]}') THEN
    RAISE EXCEPTION 'tiered pricing with no tiers is accepted';
  END IF;
  IF public.first_cleanup_pricing_is_valid('{"mode":"sometimes"}')
     OR public.first_cleanup_pricing_is_valid('{"mode":"flat","per_extra_dog_cents":-5}')
     OR public.first_cleanup_pricing_is_valid('{"mode":"flat","per_extra_dog_cents":12.5}')
     OR public.first_cleanup_pricing_is_valid(
          '{"mode":"by_last_cleaned","tiers":[{"id":"a","label":"A","price_cents":1},{"id":"a","label":"B","price_cents":2}]}')
     OR public.first_cleanup_pricing_is_valid(
          '{"mode":"by_last_cleaned","tiers":[{"id":"a","label":" ","price_cents":1}]}')
     OR public.first_cleanup_pricing_is_valid(
          '{"mode":"by_last_cleaned","tiers":[{"id":"a","label":"A","price_cents":"75"}]}') THEN
    RAISE EXCEPTION 'first_cleanup_pricing_is_valid accepts a config it should refuse';
  END IF;

  -- The price.
  IF public.first_cleanup_price_cents('{"mode":"off"}', 7500, 3, NULL) <> 0 THEN
    RAISE EXCEPTION 'off still charges a first cleanup';
  END IF;
  IF public.first_cleanup_price_cents('{"mode":"flat"}', 7500, 1, NULL) <> 7500 THEN
    RAISE EXCEPTION 'flat does not charge the zone price';
  END IF;
  IF public.first_cleanup_price_cents(_tiers, 7500, 1, 'month') <> 7500
     OR public.first_cleanup_price_cents(_tiers, 99999, 3, 'week') <> 6500 THEN
    RAISE EXCEPTION 'a tier is not priced as tier + extra dogs, independent of the zone';
  END IF;
  IF public.first_cleanup_price_cents(_tiers, 7500, 4, 'free') <> 0 THEN
    RAISE EXCEPTION 'a free tier charges for the dogs';
  END IF;
  IF public.first_cleanup_price_cents(_tiers, 7500, 1, NULL) IS NOT NULL
     OR public.first_cleanup_price_cents(_tiers, 7500, 1, 'nope') IS NOT NULL THEN
    RAISE EXCEPTION 'tiered pricing invents a price for a tier nobody picked';
  END IF;

  -- The column and its default.
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name = 'first_cleanup_pricing') !~ '"mode": ?"off"' THEN
    RAISE EXCEPTION 'first_cleanup_pricing does not default to off';
  END IF;

  -- public_quote: one signature, still callable with the publishable key, and
  -- no longer by PUBLIC.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'public_quote') <> 1 THEN
    RAISE EXCEPTION 'public_quote must have exactly one signature, or a four-argument call is ambiguous';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the signup page can no longer price a visit';
  END IF;
  IF has_function_privilege('anon', 'public.first_cleanup_price_cents(jsonb, integer, integer, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.first_cleanup_pricing_is_valid(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a first-cleanup helper is executable by the publishable key';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.public_quote(text, text, integer, text, text)'::regprocedure)
       !~ 'first_cleanup_price_cents' THEN
    RAISE EXCEPTION 'public_quote does not price the first cleanup through first_cleanup_price_cents';
  END IF;
END;
$check$;
