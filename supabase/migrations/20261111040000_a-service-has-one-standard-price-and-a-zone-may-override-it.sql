-- One standard price per service, and a zone may override it (#860).
--
-- Decision, Brendan, 2026-11-10: "Approve, but this should be a setting".
-- Each service has ONE standard price, set in Settings -> Services. A zone may
-- override it, and the override applies only inside that zone. Every place
-- that offers a price reads that one setting. Existing plans keep the price
-- they were saved with (subscriptions.price_cents is not touched here, and
-- nothing in this file reads it).
--
-- Before this, a pet-waste visit had three places to be priced: the zone
-- (zones.base_price_cents, NOT NULL DEFAULT 2000, so every zone always had a
-- price whether anybody chose one or not), Business defaults' Standard pricing
-- (organizations.std_base_price_cents, read by nothing that priced a plan),
-- and the service (services.base_price_cents, ignored for pet waste). The
-- tester saved $20 under Business defaults and the new-client wizard still
-- said "No zone matches ZIP 48933. Set price manually below."
--
-- 1. zones.base_price_cents and per_dog_addl_cents become nullable, with no
--    default. NULL is "no override: this zone charges the standard price".
--    Every existing zone keeps the number it has, so every existing zone
--    keeps overriding exactly as it priced yesterday. Nothing is repriced.
--
-- 2. The standard price lives on the pet-waste service. A business that had
--    saved Standard pricing under Business defaults gets that number copied
--    onto each of its pet-waste services that has no price yet, so the price
--    it typed is the one Settings -> Services now shows. A service that
--    already has a price keeps it. Replays into an empty database as a no-op.
--
-- 3. public_quote (the online signup and the AI receptionist) applies the same
--    rule: COALESCE(zone override, service standard). Spliced, so every
--    earlier splice of it stands; signature, SECURITY DEFINER, search_path
--    and grants are kept by CREATE OR REPLACE.
--
-- The organizations.std_* columns are left in place (the setup step still
-- writes them while they are empty) but nothing reads them for a price.

-- ── 1. A zone's price is an override ─────────────────────────────────────

ALTER TABLE public.zones ALTER COLUMN base_price_cents DROP NOT NULL;
ALTER TABLE public.zones ALTER COLUMN base_price_cents DROP DEFAULT;
ALTER TABLE public.zones ALTER COLUMN per_dog_addl_cents DROP NOT NULL;
ALTER TABLE public.zones ALTER COLUMN per_dog_addl_cents DROP DEFAULT;

COMMENT ON COLUMN public.zones.base_price_cents IS
  'This zone''s override of the pet-waste standard price (services.base_price_cents), per visit, first dog. NULL: the zone charges the standard price. Applies only to an address inside the zone (#860).';
COMMENT ON COLUMN public.zones.per_dog_addl_cents IS
  'Each extra dog, per visit, read with base_price_cents when this zone overrides the standard price. NULL with no override (#860).';

-- ── 2. The Business-defaults price moves onto the service ────────────────

UPDATE public.services s
   SET base_price_cents = o.std_base_price_cents,
       extra_pet_cents = COALESCE(o.std_per_dog_addl_cents, s.extra_pet_cents)
  FROM public.organizations o
 WHERE s.organization_id = o.id
   AND s.service_line = 'pet_waste'
   AND s.base_price_cents IS NULL
   AND o.std_base_price_cents IS NOT NULL;

-- ── 3. public_quote: zone override, else the standard price ──────────────
--
-- Spliced, as 20261025200000, 20261027200000, 20261028120000, 20261029120000
-- and 20261029180000 did: the newest body is read back with
-- pg_get_functiondef (one named function), three anchors are replaced, each
-- of which must appear exactly once, and the result is executed. Every
-- earlier splice (the bookable and office-booked filters, twice weekly per
-- week, a zone that is off) is kept because the body is never retyped. A body
-- that already reads the standard price is left alone, so a replay is a no-op.
-- The function's COMMENT (20261024100900) is left as it is: this file is a
-- splice, not a restatement, and the tests that follow the latest
-- definition of public_quote read the file that last defined it.

DO $splice$
DECLARE
  _def text;
  _decl_from CONSTANT text := '_mode text;';
  _decl_to   CONSTANT text := '_mode text;
  _rate_base integer;
  _rate_dog integer;';
  _base_from CONSTANT text := '_base_visit_cents := _zone.base_price_cents + GREATEST(_dog_count - 1, 0) * _zone.per_dog_addl_cents;';
  _base_to   CONSTANT text := '-- #860 (20261111040000): the zone''s OVERRIDE when it has one, else the
  -- pet-waste service''s STANDARD price: the named service, or with none
  -- named the business''s default pet-waste service, picked as
  -- defaultPetWasteService picks it (src/lib/standard-price.ts). Neither
  -- set: NULL prices, which the signup reads as "not priced online yet"
  -- (signup-charge.ts SERVICE_NOT_PRICED) and never as $0.
  IF _svc.id IS NULL THEN
    SELECT s.* INTO _svc FROM public.services s
     WHERE s.organization_id = _org.id
       AND s.active
       AND s.service_line = ''pet_waste''
     ORDER BY (s.name = ''Pet waste removal'') DESC, lower(s.name), s.id
     LIMIT 1;
  END IF;
  IF _zone.base_price_cents IS NOT NULL THEN
    _rate_base := _zone.base_price_cents;
    _rate_dog := COALESCE(_zone.per_dog_addl_cents, 0);
  ELSIF _svc.base_price_cents IS NOT NULL THEN
    _rate_base := _svc.base_price_cents;
    _rate_dog := COALESCE(_svc.extra_pet_cents, 0);
  END IF;
  _base_visit_cents := _rate_base + GREATEST(_dog_count - 1, 0) * _rate_dog;';
  _dog_from CONSTANT text := 'per_dog_addl_cents := _zone.per_dog_addl_cents;';
  _dog_to   CONSTANT text := 'per_dog_addl_cents := _rate_dog;';
  _anchor text;
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure);
  IF strpos(_def, '_rate_base') > 0 THEN
    RAISE NOTICE 'public_quote already reads the standard price; leaving it alone.';
    RETURN;
  END IF;
  FOREACH _anchor IN ARRAY ARRAY[_decl_from, _base_from, _dog_from] LOOP
    _n := (length(_def) - length(replace(_def, _anchor, ''))) / length(_anchor);
    IF _n IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'public_quote contains "%" % time(s), not once; the splice anchor moved.',
        _anchor, _n;
    END IF;
  END LOOP;
  _def := replace(_def, _decl_from, _decl_to);
  _def := replace(_def, _base_from, _base_to);
  _def := replace(_def, _dog_from, _dog_to);
  EXECUTE _def;
END
$splice$;

-- ── What this file establishes ────────────────────────────────────────────

DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'zones'
       AND column_name IN ('base_price_cents', 'per_dog_addl_cents')
       AND (is_nullable <> 'YES' OR column_default IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'zones.base_price_cents / per_dog_addl_cents must be nullable with no default (#860)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.public_quote(text, text, integer, text, text, uuid)'::regprocedure
       AND p.prosrc LIKE '%_rate_base%'
       AND p.prosrc NOT LIKE '%_zone.base_price_cents + GREATEST%'
  ) THEN
    RAISE EXCEPTION 'public_quote does not read the standard price (#860)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'public_quote') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'public.public_quote has more than one overload; the splice reached only one';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the public signup lost public_quote';
  END IF;
END;
$check$;
